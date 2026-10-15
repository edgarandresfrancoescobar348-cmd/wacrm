import { BroadcastsFrame } from "@/components/broadcasts/broadcasts-frame";

// List + detail frame for every broadcasts route. The list panel lives
// here (not in each page) so it stays mounted while the main pane
// navigates between the empty state, a detail and the wizard.
export default function BroadcastsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <BroadcastsFrame>{children}</BroadcastsFrame>;
}
