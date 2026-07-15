export const validateArchiveQuery = (value: string): string | undefined =>
  value.length <= 500 ? undefined : "archive_query_too_long";

export const validateSubscriptionName = (value: string): string | undefined => {
  const length = value.trim().length;
  return length > 0 && length <= 200 ? undefined : "subscription_name_invalid";
};

export const validateEmailAddress = (value: string): string | undefined => {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320) return "email_invalid";
  const separator = normalized.indexOf("@");
  if (separator < 1 || separator !== normalized.lastIndexOf("@")) return "email_invalid";
  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  if (
    local.length > 64 ||
    domain.length > 255 ||
    !domain.includes(".") ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    normalized.includes(" ")
  ) {
    return "email_invalid";
  }
  return undefined;
};

export interface PublisherOnboardingFormValues {
  readonly companyName: string;
  readonly firstAdminEmail: string;
}

export const validatePublisherOnboarding = (
  value: PublisherOnboardingFormValues,
): string | undefined => {
  if (value.companyName.trim().length === 0 || value.companyName.trim().length > 200) {
    return "publisher_company_name_invalid";
  }
  return validateEmailAddress(value.firstAdminEmail);
};
