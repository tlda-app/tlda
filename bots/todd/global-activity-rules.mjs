const APP_TESTING_PLAYWRIGHT_INSTALL_PATTERN =
  /\b(?:npx\s+playwright\s+install|playwright\s+install(?:\s+chromium)?|(?:npm\s+(?:i|install)|pnpm\s+add|yarn\s+add)(?:\s+(?:-D|--save-dev|--dev))*\s+(?:@playwright\/test|playwright)\b|chromium\s+(?:isn['’]?t|is\s+not)\s+installed\b|install\s+chromium\b)/i

export const GLOBAL_ACTIVITY_RULES = [
  {
    name: 'app-testing-playwright-install',
    pattern: APP_TESTING_PLAYWRIGHT_INSTALL_PATTERN,
    message: "have you read the app-testing skill? use `tlda-dev pw` — it's installed and more convenient.",
    cooldownMs: 10 * 60_000,
  },
]

export function matchGlobalActivityRule(commandText) {
  if (!commandText) return null
  return GLOBAL_ACTIVITY_RULES.find(rule => rule.pattern.test(commandText)) || null
}
