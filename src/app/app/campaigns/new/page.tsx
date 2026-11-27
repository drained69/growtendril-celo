import { Gift } from "lucide-react";
import { requireProject } from "@/server/auth/current";
import { Card, CardBody, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { NewOpenCampaignForm } from "@/components/features/campaigns/open-forms";

export default async function NewOpenCampaign() {
  await requireProject("manage_policy");
  return <div className="mx-auto max-w-2xl space-y-5">
    <PageHeader title="New reward campaign" description="Pay people a fixed reward for doing something for your business, like posting about it. Anyone with the link can join." actions={<LinkButton href="/app/campaigns">All campaigns</LinkButton>} />
    <Card><CardHeader title="What's the deal?" icon={<Gift />} description="You can change these until you set the money aside." /><CardBody><NewOpenCampaignForm /></CardBody></Card>
    <div className="space-y-2 text-xs text-ink-3">
      <p><strong className="text-ink-2">How people get paid.</strong> Each person agrees to your terms and gets a personal code to put in their post. GrowTendril checks the post. When it passes, the reward waits 3 days so you can object, then goes to their wallet automatically.</p>
      <p><strong className="text-ink-2">Where the money sits.</strong> You set the whole amount aside from your own wallet into a contract on the Celo network before anyone joins. It can only go to approved people, or back to you. GrowTendril never holds it.</p>
    </div>
  </div>;
}
