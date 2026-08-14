import { WorkspacePage } from "./workspace-page";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <WorkspacePage pathname="/" />;
}
