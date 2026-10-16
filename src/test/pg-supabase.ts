// ============================================================
// A small supabase-js look-alike over the ephemeral PostgreSQL harness,
// so server code (deliverBroadcast, the continuation, the attempt RPCs)
// runs against REAL tables, triggers and functions in tests — not mocks.
//
// Covers the slice of the PostgREST builder this code uses: select
// (columns, `alias:table(cols)` to-one embeds, count/head), insert,
// update, delete, filters eq/neq/in/is/not-is/lt/lte/gt/gte/or, order,
// limit, range, single/maybeSingle, and rpc. Every call runs in its own
// psql session, so Promise.all gives real concurrency.
//
// `failOn` makes chosen operations fail like PostgREST would (an error
// object, no throw) — fault injection for the "a write failed" paths.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Pg } from './pg-harness'

type Row = Record<string, unknown>
type Result = { data: unknown; error: { message: string } | null; count?: number | null }

export interface FailRule {
  table?: string
  rpc?: string
  op?: 'select' | 'insert' | 'update' | 'delete'
  /** Only when the update/insert payload has this key. */
  key?: string
  /** Fail this many times (default: always). */
  times?: number
}

export function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  // A flat array of strings is a Postgres array (uuid[] / text[]
  // arguments, as PostgREST coerces them); any other array is JSON.
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
    const inner = (v as string[]).map((x) => `"${x.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(',')
    return `'{${inner.replace(/'/g, "''")}}'`
  }
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  return `'${String(v).replace(/'/g, "''")}'`
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`

/** `a, b, contact:contacts(phone)` → SQL select list for alias `t`. */
function selectList(table: string, cols: string): string {
  if (!cols || cols.trim() === '*') return 't.*'
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of cols) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
    .map((p) => {
      const embed = p.match(/^(\w+):(\w+)\(([^)]*)\)$/)
      if (embed) {
        const [, alias, other, inner] = embed
        const fk = `${other.replace(/s$/, '')}_id`
        const fields = inner.split(',').map((c) => c.trim())
        const obj = fields.map((c) => `'${c}', e.${ident(c)}`).join(', ')
        return `(SELECT json_build_object(${obj}) FROM public.${ident(other)} e WHERE e.id = t.${ident(fk)}) AS ${ident(alias)}`
      }
      return `t.${ident(p)}`
    })
    .join(', ')
}

class Builder implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private cols = '*'
  private countMode = false
  private headOnly = false
  private payload: Row | Row[] | null = null
  private returning: string | null = null
  private where: string[] = []
  private orders: string[] = []
  private lim: number | null = null
  private off = 0
  private one: 'single' | 'maybe' | null = null

  constructor(
    private readonly client: PgSupabase,
    private readonly table: string,
  ) {}

  select(cols = '*', opts: { count?: string; head?: boolean } = {}) {
    if (this.op === 'select') {
      this.cols = cols
      this.countMode = !!opts.count
      this.headOnly = !!opts.head
    } else this.returning = cols
    return this
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert'
    this.payload = rows
    return this
  }
  update(patch: Row) {
    this.op = 'update'
    this.payload = patch
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  eq(c: string, v: unknown) {
    this.where.push(v === null ? `t.${ident(c)} IS NULL` : `t.${ident(c)} = ${lit(v)}`)
    return this
  }
  neq(c: string, v: unknown) {
    this.where.push(`t.${ident(c)} IS DISTINCT FROM ${lit(v)}`)
    return this
  }
  in(c: string, vs: unknown[]) {
    this.where.push(vs.length ? `t.${ident(c)} IN (${vs.map(lit).join(', ')})` : 'false')
    return this
  }
  is(c: string, v: null) {
    this.where.push(`t.${ident(c)} IS ${v === null ? 'NULL' : lit(v)}`)
    return this
  }
  not(c: string, opr: string, v: unknown) {
    if (opr === 'is') this.where.push(`t.${ident(c)} IS NOT ${v === null ? 'NULL' : lit(v)}`)
    else this.where.push(`NOT (t.${ident(c)} ${opr === 'eq' ? '=' : opr} ${lit(v)})`)
    return this
  }
  lt(c: string, v: unknown) {
    this.where.push(`t.${ident(c)} < ${lit(v)}`)
    return this
  }
  lte(c: string, v: unknown) {
    this.where.push(`t.${ident(c)} <= ${lit(v)}`)
    return this
  }
  gt(c: string, v: unknown) {
    this.where.push(`t.${ident(c)} > ${lit(v)}`)
    return this
  }
  gte(c: string, v: unknown) {
    this.where.push(`t.${ident(c)} >= ${lit(v)}`)
    return this
  }
  /** PostgREST `or`: `a.is.null,a.lt.2026-…` */
  or(expr: string) {
    const terms = expr.split(',').map((term) => {
      const [c, opr, ...rest] = term.split('.')
      const v = rest.join('.')
      const col = `t.${ident(c)}`
      if (opr === 'is') return `${col} IS ${v === 'null' ? 'NULL' : v}`
      const sqlOp = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=', neq: '<>' }[opr]
      if (!sqlOp) throw new Error(`pg-supabase: unsupported or() operator ${opr}`)
      return `${col} ${sqlOp} ${lit(v)}`
    })
    this.where.push(`(${terms.join(' OR ')})`)
    return this
  }
  order(c: string, opts: { ascending?: boolean } = {}) {
    this.orders.push(`t.${ident(c)} ${opts.ascending === false ? 'DESC' : 'ASC'}`)
    return this
  }
  limit(n: number) {
    this.lim = n
    return this
  }
  range(from: number, to: number) {
    this.off = from
    this.lim = to - from + 1
    return this
  }
  single() {
    this.one = 'single'
    return this
  }
  maybeSingle() {
    this.one = 'maybe'
    return this
  }

  private sql(): string {
    const tbl = `public.${ident(this.table)}`
    const w = this.where.length ? ` WHERE ${this.where.join(' AND ')}` : ''
    if (this.op === 'select') {
      const order = this.orders.length ? ` ORDER BY ${this.orders.join(', ')}` : ''
      const page = `${this.lim !== null ? ` LIMIT ${this.lim}` : ''}${this.off ? ` OFFSET ${this.off}` : ''}`
      const rows = `SELECT ${selectList(this.table, this.cols)} FROM ${tbl} t${w}${order}${page}`
      const count = this.countMode ? `(SELECT count(*) FROM ${tbl} t${w})` : 'NULL'
      return `SELECT json_build_object('data', ${this.headOnly ? 'NULL' : `COALESCE((SELECT json_agg(r) FROM (${rows}) r), '[]'::json)`}, 'count', ${count})`
    }
    const ret = this.returning ? ` RETURNING ${selectList(this.table, this.returning)}` : ''
    let stmt: string
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row]
      const keys = Object.keys(rows[0] ?? {})
      stmt = `INSERT INTO ${tbl} AS t (${keys.map(ident).join(', ')}) VALUES ${rows
        .map((r) => `(${keys.map((k) => lit(r[k])).join(', ')})`)
        .join(', ')}${ret}`
    } else if (this.op === 'update') {
      const set = Object.entries(this.payload as Row)
        .map(([k, v]) => `${ident(k)} = ${lit(v)}`)
        .join(', ')
      stmt = `UPDATE ${tbl} t SET ${set}${w}${ret}`
    } else {
      stmt = `DELETE FROM ${tbl} t${w}${ret}`
    }
    return `WITH x AS (${stmt}${ret ? '' : ' RETURNING 1'}) SELECT json_build_object('data', ${
      ret ? `COALESCE((SELECT json_agg(x) FROM x), '[]'::json)` : 'NULL'
    }, 'count', (SELECT count(*) FROM x))`
  }

  async run(): Promise<Result> {
    const key = this.payload && !Array.isArray(this.payload) ? Object.keys(this.payload) : []
    if (this.client.shouldFail({ table: this.table, op: this.op, keys: key })) {
      return { data: null, error: { message: `injected failure: ${this.op} ${this.table}` } }
    }
    let out: string
    try {
      out = await this.client.pg.sql(this.sql())
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : String(err) } }
    }
    const parsed = JSON.parse(out) as { data: Row[] | null; count: number | null }
    let data: unknown = parsed.data
    if (this.one) {
      const rows = (parsed.data ?? []) as Row[]
      if (rows.length > 1) return { data: null, error: { message: 'more than one row' } }
      if (rows.length === 0 && this.one === 'single') return { data: null, error: { message: 'no rows' } }
      data = rows[0] ?? null
    }
    return { data, error: null, count: parsed.count }
  }

  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onfulfilled, onrejected)
  }
}

export class PgSupabase {
  private readonly rules: FailRule[] = []
  private readonly fnKinds = new Map<string, boolean>()
  /** Every rpc name called, in order. */
  readonly rpcLog: string[] = []

  constructor(readonly pg: Pg) {}

  failOn(rule: FailRule) {
    this.rules.push({ ...rule })
  }
  clearFailures() {
    this.rules.length = 0
  }

  shouldFail(q: { table?: string; rpc?: string; op?: string; keys?: string[] }): boolean {
    const rule = this.rules.find(
      (r) =>
        (r.times === undefined || r.times > 0) &&
        (r.table === undefined || r.table === q.table) &&
        (r.rpc === undefined || r.rpc === q.rpc) &&
        (r.op === undefined || r.op === q.op) &&
        (r.key === undefined || (q.keys ?? []).includes(r.key)) &&
        (r.table !== undefined || r.rpc !== undefined),
    )
    if (!rule) return false
    if (rule.times !== undefined) rule.times--
    return true
  }

  from(table: string) {
    return new Builder(this, table)
  }

  private async returnsRows(fn: string): Promise<boolean> {
    if (!this.fnKinds.has(fn)) {
      const kind = await this.pg.sql(
        `SELECT t.typtype FROM pg_proc p JOIN pg_type t ON t.oid = p.prorettype WHERE p.proname = ${lit(fn)} LIMIT 1`,
      )
      this.fnKinds.set(fn, kind === 'c')
    }
    return this.fnKinds.get(fn)!
  }

  async rpc(fn: string, args: Row = {}): Promise<Result> {
    this.rpcLog.push(fn)
    if (this.shouldFail({ rpc: fn })) return { data: null, error: { message: `injected failure: rpc ${fn}` } }
    const named = Object.entries(args)
      .map(([k, v]) => `${ident(k)} => ${lit(v)}`)
      .join(', ')
    try {
      const rows = await this.returnsRows(fn)
      const out = rows
        ? await this.pg.sql(`SELECT COALESCE(json_agg(x), '[]'::json) FROM public.${ident(fn)}(${named}) x`)
        : await this.pg.sql(`SELECT COALESCE(to_json(public.${ident(fn)}(${named}))::text, 'null')`)
      return { data: JSON.parse(out), error: null }
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : String(err) } }
    }
  }

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient
  }
}
