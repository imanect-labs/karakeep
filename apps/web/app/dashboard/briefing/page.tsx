import type { Metadata } from "next";
import BriefingView from "@/components/dashboard/briefing/BriefingView";

export const metadata: Metadata = {
  title: "Briefing | Karakeep",
};

export default function BriefingPage() {
  return <BriefingView />;
}
