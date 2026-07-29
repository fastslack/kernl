/**
 * PII (Personally Identifiable Information) Filter
 * 
 * Detects and redacts sensitive data before sending to external LLM APIs.
 * Configurable via environment variables.
 */

export interface PiiFilterConfig {
  enabled: boolean;
  redactEmails: boolean;
  redactPhones: boolean;
  redactCreditCards: boolean;
  redactIbans: boolean;
  redactIps: boolean;
  redactNames: boolean;           // Redact known contact names
  redactAddresses: boolean;       // Basic address patterns
  customPatterns: RegExp[];       // User-defined patterns
  knownNames: Set<string>;        // Names from contacts to redact
  placeholder: string;            // What to replace with (default: "[REDACTED]")
}

export interface PiiDetectionResult {
  hasPersonalData: boolean;
  detectedTypes: string[];
  redactedText: string;
  originalLength: number;
  redactedCount: number;
}

// Common patterns for PII detection
// NOTE: Order matters! More specific patterns should be checked first
const PATTERNS = {
  // Email: standard email pattern
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  
  // Credit card: 13-19 digits with specific separators (must match before phone)
  creditCard: /\b(?:\d{4}[-\s]){3}\d{4}\b|\b\d{13,19}\b/g,
  
  // US SSN pattern: exactly 3-2-4 digits (must match before phone)
  ssn: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g,
  
  // IBAN: International Bank Account Number
  iban: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/gi,
  
  // IP addresses (v4)
  ipv4: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
  
  // Phone: international formats - more specific to avoid matching credit cards/SSN
  // Requires + prefix or specific formats
  phone: /(?:\+\d{1,4}[-.\s]?)(?:\(?\d{1,4}\)?[-.\s]?)?\d{2,4}[-.\s]?\d{2,4}[-.\s]?\d{2,6}\b|\b0\d[-.\s]?\d{2,4}[-.\s]?\d{2,4}[-.\s]?\d{2,4}\b/g,
  
  // Dutch postal codes (as example for address)
  dutchPostal: /\b\d{4}\s?[A-Z]{2}\b/gi,
  
  // Passport numbers (generic)
  passport: /\b[A-Z]{1,2}\d{6,9}\b/g,
};

/**
 * Create default PII filter config from environment
 */
export function createPiiConfig(env: Record<string, string | undefined> = process.env): PiiFilterConfig {
  const enabled = env.PII_FILTER_ENABLED !== "false"; // Default: enabled
  
  return {
    enabled,
    redactEmails: env.PII_REDACT_EMAILS !== "false",
    redactPhones: env.PII_REDACT_PHONES !== "false",
    redactCreditCards: env.PII_REDACT_CREDIT_CARDS !== "false",
    redactIbans: env.PII_REDACT_IBANS !== "false",
    redactIps: env.PII_REDACT_IPS !== "false",
    redactNames: env.PII_REDACT_NAMES === "true", // Default: false (opt-in)
    redactAddresses: env.PII_REDACT_ADDRESSES === "true", // Default: false
    customPatterns: [],
    knownNames: new Set(),
    placeholder: env.PII_PLACEHOLDER || "[REDACTED]",
  };
}

/**
 * PII Filter class
 */
export class PiiFilter {
  private config: PiiFilterConfig;
  private namePattern: RegExp | null = null;

  constructor(config: Partial<PiiFilterConfig> = {}) {
    this.config = { ...createPiiConfig(), ...config };
    this.updateNamePattern();
  }

  /**
   * Update the list of known names to redact
   */
  setKnownNames(names: string[]): void {
    this.config.knownNames = new Set(
      names
        .filter(n => n && n.length > 2) // Skip very short names
        .map(n => n.trim())
    );
    this.updateNamePattern();
  }

  /**
   * Add custom regex patterns to redact
   */
  addCustomPattern(pattern: RegExp): void {
    this.config.customPatterns.push(pattern);
  }

  /**
   * Update the compiled name pattern
   */
  private updateNamePattern(): void {
    if (this.config.knownNames.size === 0) {
      this.namePattern = null;
      return;
    }
    
    // Escape special regex characters and build pattern
    const escaped = Array.from(this.config.knownNames)
      .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length); // Longer names first
    
    this.namePattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
  }

  /**
   * Check if text contains PII (without redacting)
   */
  detect(text: string): { hasPersonalData: boolean; types: string[] } {
    const types: string[] = [];
    
    if (this.config.redactEmails && PATTERNS.email.test(text)) {
      types.push("email");
    }
    if (this.config.redactPhones && PATTERNS.phone.test(text)) {
      types.push("phone");
    }
    if (this.config.redactCreditCards && PATTERNS.creditCard.test(text)) {
      types.push("credit_card");
    }
    if (this.config.redactIbans && PATTERNS.iban.test(text)) {
      types.push("iban");
    }
    if (this.config.redactIps && PATTERNS.ipv4.test(text)) {
      types.push("ip_address");
    }
    if (PATTERNS.ssn.test(text)) {
      types.push("ssn");
    }
    if (this.config.redactNames && this.namePattern?.test(text)) {
      types.push("name");
    }
    
    // Reset regex lastIndex
    Object.values(PATTERNS).forEach(p => p.lastIndex = 0);
    if (this.namePattern) this.namePattern.lastIndex = 0;
    
    return { hasPersonalData: types.length > 0, types };
  }

  /**
   * Redact PII from text
   */
  redact(text: string): PiiDetectionResult {
    if (!this.config.enabled) {
      return {
        hasPersonalData: false,
        detectedTypes: [],
        redactedText: text,
        originalLength: text.length,
        redactedCount: 0,
      };
    }

    let redactedText = text;
    const detectedTypes: string[] = [];
    let redactedCount = 0;
    const placeholder = this.config.placeholder;

    // Helper to count and replace
    const redactPattern = (pattern: RegExp, typeName: string) => {
      const matches = redactedText.match(pattern);
      if (matches && matches.length > 0) {
        detectedTypes.push(typeName);
        redactedCount += matches.length;
        redactedText = redactedText.replace(pattern, placeholder);
      }
      pattern.lastIndex = 0; // Reset for global patterns
    };

    // Apply redactions in order (more specific patterns first!)
    // 1. Credit cards first (before phone can match them)
    if (this.config.redactCreditCards) {
      redactPattern(PATTERNS.creditCard, "credit_card");
    }
    
    // 2. SSN (before phone can match them)
    redactPattern(PATTERNS.ssn, "ssn");
    
    // 3. IBAN
    if (this.config.redactIbans) {
      redactPattern(PATTERNS.iban, "iban");
    }
    
    // 4. Emails
    if (this.config.redactEmails) {
      redactPattern(PATTERNS.email, "email");
    }
    
    // 5. Phone (after more specific numeric patterns)
    if (this.config.redactPhones) {
      redactPattern(PATTERNS.phone, "phone");
    }
    
    // 6. IP addresses
    if (this.config.redactIps) {
      redactPattern(PATTERNS.ipv4, "ip_address");
    }
    
    // Redact known names if enabled
    if (this.config.redactNames && this.namePattern) {
      const matches = redactedText.match(this.namePattern);
      if (matches && matches.length > 0) {
        detectedTypes.push("name");
        redactedCount += matches.length;
        redactedText = redactedText.replace(this.namePattern, placeholder);
      }
      this.namePattern.lastIndex = 0;
    }
    
    // Apply custom patterns
    for (const pattern of this.config.customPatterns) {
      const matches = redactedText.match(pattern);
      if (matches && matches.length > 0) {
        detectedTypes.push("custom");
        redactedCount += matches.length;
        redactedText = redactedText.replace(pattern, placeholder);
      }
      pattern.lastIndex = 0;
    }

    return {
      hasPersonalData: detectedTypes.length > 0,
      detectedTypes: [...new Set(detectedTypes)], // Unique types
      redactedText,
      originalLength: text.length,
      redactedCount,
    };
  }

  /**
   * Get current config
   */
  getConfig(): Readonly<PiiFilterConfig> {
    return { ...this.config };
  }

  /**
   * Check if filter is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// Singleton instance for app-wide use
let globalFilter: PiiFilter | null = null;

export function getGlobalPiiFilter(): PiiFilter {
  if (!globalFilter) {
    globalFilter = new PiiFilter();
  }
  return globalFilter;
}

export function initGlobalPiiFilter(config: Partial<PiiFilterConfig>): PiiFilter {
  globalFilter = new PiiFilter(config);
  return globalFilter;
}
