import OrganizationBrowser from "@/components/organization-browser";
import { getOrganizations } from "@/lib/organizations";

export default async function Home() {
  const { organizations, targetYear } = await getOrganizations();

  return <OrganizationBrowser organizations={organizations} targetYear={targetYear} />;
}
