export type Organization = {
  name: string;
  description: string;
  technology: string;
  topic: string;
  website: string;
  gsocLink: string;
  t1: boolean | null;
  t2: boolean | null;
  t3: boolean | null;
  t4: boolean | null;
  t5: boolean | null;
  years: string;
  predictedPresence: boolean;
  probability: number;
};

export type OrganizationsResponse = {
  organizations: Organization[];
  targetYear: number;
};
