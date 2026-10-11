export type Organization = {
  name: string;
  description: string;
  technology: string;
  topic: string;
  website: string;
  gsocLink: string;
  predictedPresence: boolean;
  probability: number;
  model: string;
};

export type OrganizationsResponse = {
  organizations: Organization[];
  targetYear: number;
};
