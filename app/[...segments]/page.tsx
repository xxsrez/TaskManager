import type { Metadata } from "next";
import { WorkspacePage, workspaceMetadata } from "../workspace-page";
import { pathFromRouteSegments } from "@/lib/navigation";

export const dynamic = "force-dynamic";

type RouteProps = {
  params: Promise<{ segments: string[] }>;
};

export default async function WorkspaceRoute({ params }: RouteProps) {
  const pathname = pathFromRouteSegments((await params).segments);
  return <WorkspacePage pathname={pathname} />;
}

export async function generateMetadata({ params }: RouteProps): Promise<Metadata> {
  const pathname = pathFromRouteSegments((await params).segments);
  return workspaceMetadata(pathname);
}
