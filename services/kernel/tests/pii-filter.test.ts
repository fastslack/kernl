import { describe, it, expect, beforeEach } from "bun:test";
import { PiiFilter, createPiiConfig } from "../src/core/pii-filter.js";

describe("PiiFilter", () => {
  let filter: PiiFilter;

  beforeEach(() => {
    filter = new PiiFilter({ enabled: true });
  });

  describe("Email detection", () => {
    it("redacts email addresses", () => {
      const result = filter.redact("Contact me at john@example.com");
      expect(result.redactedText).toBe("Contact me at [REDACTED]");
      expect(result.detectedTypes).toContain("email");
      expect(result.redactedCount).toBe(1);
    });

    it("redacts multiple emails", () => {
      const result = filter.redact("Email john@test.com or jane@work.org");
      expect(result.redactedText).toBe("Email [REDACTED] or [REDACTED]");
      expect(result.redactedCount).toBe(2);
    });

    it("handles various email formats", () => {
      const emails = [
        "user.name+tag@example.co.uk",
        "simple@test.com",
        "name123@domain.io",
      ];
      for (const email of emails) {
        const result = filter.redact(`Contact: ${email}`);
        expect(result.detectedTypes).toContain("email");
      }
    });
  });

  describe("Phone detection", () => {
    it("redacts phone numbers with country code", () => {
      const result = filter.redact("Call me at +31612345678");
      expect(result.detectedTypes).toContain("phone");
      expect(result.redactedCount).toBeGreaterThan(0);
    });

    it("redacts phone numbers with dashes", () => {
      const result = filter.redact("Phone: 06-1234-5678");
      expect(result.detectedTypes).toContain("phone");
    });

    it("redacts international formats", () => {
      const phones = [
        "+1 (555) 123-4567",
        "+44 20 7946 0958",
        "06 12 34 56 78",
      ];
      for (const phone of phones) {
        const result = filter.redact(`Call ${phone}`);
        expect(result.hasPersonalData).toBe(true);
      }
    });
  });

  describe("Credit card detection", () => {
    it("redacts credit card numbers", () => {
      const result = filter.redact("Card: 4111-1111-1111-1111");
      expect(result.detectedTypes).toContain("credit_card");
    });

    it("redacts cards with spaces", () => {
      const result = filter.redact("Pay with 4111 1111 1111 1111");
      expect(result.detectedTypes).toContain("credit_card");
    });
  });

  describe("IBAN detection", () => {
    it("redacts IBAN numbers", () => {
      const result = filter.redact("Transfer to NL91ABNA0417164300");
      expect(result.detectedTypes).toContain("iban");
    });
  });

  describe("SSN detection", () => {
    it("redacts SSN numbers", () => {
      const result = filter.redact("SSN: 123-45-6789");
      expect(result.detectedTypes).toContain("ssn");
    });
  });

  describe("Name redaction", () => {
    it("redacts known names when enabled", () => {
      const filterWithNames = new PiiFilter({
        enabled: true,
        redactNames: true,
      });
      filterWithNames.setKnownNames(["John Doe", "Jane Smith"]);

      const result = filterWithNames.redact("Meeting with John Doe tomorrow");
      expect(result.redactedText).toBe("Meeting with [REDACTED] tomorrow");
      expect(result.detectedTypes).toContain("name");
    });

    it("does not redact names when disabled", () => {
      filter.setKnownNames(["John Doe"]);
      const result = filter.redact("Meeting with John Doe");
      expect(result.redactedText).toBe("Meeting with John Doe");
    });

    it("handles multiple names", () => {
      const filterWithNames = new PiiFilter({
        enabled: true,
        redactNames: true,
      });
      filterWithNames.setKnownNames(["Alice", "Bob", "Charlie"]);

      const result = filterWithNames.redact("Alice met Bob and Charlie");
      expect(result.redactedCount).toBe(3);
    });
  });

  describe("Configuration", () => {
    it("respects enabled flag", () => {
      const disabledFilter = new PiiFilter({ enabled: false });
      const result = disabledFilter.redact("Email: test@example.com");
      expect(result.redactedText).toBe("Email: test@example.com");
      expect(result.hasPersonalData).toBe(false);
    });

    it("uses custom placeholder", () => {
      const customFilter = new PiiFilter({
        enabled: true,
        placeholder: "***",
      });
      const result = customFilter.redact("Email: test@example.com");
      expect(result.redactedText).toBe("Email: ***");
    });

    it("can disable specific types", () => {
      const selectiveFilter = new PiiFilter({
        enabled: true,
        redactEmails: false,
        redactPhones: true,
      });
      const result = selectiveFilter.redact("Email: test@example.com Phone: +1-555-123-4567");
      expect(result.redactedText).toContain("test@example.com");
      expect(result.redactedText).not.toContain("+1-555-123-4567");
    });
  });

  describe("Detection only", () => {
    it("detects PII without redacting", () => {
      const detection = filter.detect("Email: test@example.com, Phone: +31612345678");
      expect(detection.hasPersonalData).toBe(true);
      expect(detection.types).toContain("email");
      expect(detection.types).toContain("phone");
    });

    it("returns false for clean text", () => {
      const detection = filter.detect("Hello world, how are you today?");
      expect(detection.hasPersonalData).toBe(false);
      expect(detection.types).toHaveLength(0);
    });
  });

  describe("createPiiConfig", () => {
    it("creates default config", () => {
      const config = createPiiConfig({});
      expect(config.enabled).toBe(true);
      expect(config.redactEmails).toBe(true);
      expect(config.redactPhones).toBe(true);
      expect(config.redactNames).toBe(false); // Opt-in
      expect(config.placeholder).toBe("[REDACTED]");
    });

    it("respects environment overrides", () => {
      const config = createPiiConfig({
        PII_FILTER_ENABLED: "false",
        PII_REDACT_NAMES: "true",
        PII_PLACEHOLDER: "***HIDDEN***",
      });
      expect(config.enabled).toBe(false);
      expect(config.redactNames).toBe(true);
      expect(config.placeholder).toBe("***HIDDEN***");
    });
  });

  describe("Edge cases", () => {
    it("handles empty string", () => {
      const result = filter.redact("");
      expect(result.redactedText).toBe("");
      expect(result.hasPersonalData).toBe(false);
    });

    it("handles text with no PII", () => {
      const result = filter.redact("This is a normal message without any personal data");
      expect(result.redactedText).toBe("This is a normal message without any personal data");
      expect(result.redactedCount).toBe(0);
    });

    it("handles mixed content", () => {
      const text = `
        Contact: John Doe
        Email: john@company.com
        Phone: +1-555-123-4567
        Notes: Meeting at 3pm tomorrow
      `;
      const result = filter.redact(text);
      expect(result.redactedText).not.toContain("john@company.com");
      expect(result.redactedText).toContain("Meeting at 3pm");
    });
  });
});
