import type { CustomField } from "@/services/tauri";

/**
 * Pre-defined entry templates (PLAN Phase 4: template system / TMP-01).
 *
 * Selecting a template on entry creation pre-populates the icon and a set of
 * starter custom fields so common record types (credit cards, SSH servers, …)
 * are quick to fill in. Templates are a pure frontend convenience — the result
 * is an ordinary KeePass entry, so files stay fully compatible.
 */
export interface EntryTemplate {
  id: string;
  name: string;
  /** KeePass built-in icon index applied to the entry. */
  icon: number;
  /** Custom fields seeded onto the entry (values start empty). */
  fields: CustomField[];
}

function field(key: string, protectedField = false): CustomField {
  return { key, value: "", protected: protectedField };
}

export const ENTRY_TEMPLATES: EntryTemplate[] = [
  {
    id: "credit-card",
    name: "Credit Card",
    icon: 66,
    fields: [
      field("Cardholder"),
      field("Card Number", true),
      field("Expiry"),
      field("CVV", true),
      field("PIN", true),
    ],
  },
  {
    id: "email",
    name: "Email Account",
    icon: 19,
    fields: [
      field("IMAP Server"),
      field("SMTP Server"),
      field("Port"),
      field("Recovery Email"),
    ],
  },
  {
    id: "secure-note",
    name: "Secure Note",
    icon: 7,
    fields: [],
  },
  {
    id: "ssh-server",
    name: "SSH Server",
    icon: 3,
    fields: [
      field("Host"),
      field("Port"),
      field("Key Passphrase", true),
      field("Fingerprint"),
    ],
  },
  {
    id: "wifi-router",
    name: "Wi-Fi Router",
    icon: 1,
    fields: [
      field("SSID"),
      field("Wi-Fi Password", true),
      field("Admin URL"),
      field("Security"),
    ],
  },
  {
    id: "membership",
    name: "Membership / ID",
    icon: 9,
    fields: [
      field("Member ID"),
      field("Organization"),
      field("Valid Until"),
    ],
  },
  {
    id: "software-license",
    name: "Software License",
    icon: 67,
    fields: [
      field("Product"),
      field("License Key", true),
      field("Version"),
      field("Purchased"),
    ],
  },
];
