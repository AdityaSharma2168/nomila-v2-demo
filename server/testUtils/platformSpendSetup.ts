/**
 * platformSpendSetup.ts — jest setupFiles (node project): the platform day total reads 0 in tests unless a suite says
 * otherwise. The cap fails CLOSED on a read failure (lib/platformSpend.ts), and most suites mock `../db` as `{}`, so
 * without this every paid path under test would be refused. A suite that tests the cap itself installs its own reader
 * with setPlatformSpendReaderForTests (which wins over this), or calls dbPlatformSpentTodayMicroUsd directly.
 * Deliberately a global, not an import: importing platformSpend here would load it before a suite's jest.mock()s.
 */
(globalThis as { __platformSpendTestReader?: () => Promise<number> }).__platformSpendTestReader = async () => 0;
