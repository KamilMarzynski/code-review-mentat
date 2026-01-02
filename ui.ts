import chalk from 'chalk';
import * as clack from '@clack/prompts';

// Dune/Mentat theme
export const theme = {
  primary: chalk.hex('#D4AF37'), // Gold
  secondary: chalk.hex('#8B7355'), // Sand
  accent: chalk.hex('#4A90E2'), // Spice blue
  success: chalk.hex('#2ECC71'), // Green
  warning: chalk.hex('#F39C12'), // Orange
  error: chalk.hex('#E74C3C'), // Red
  muted: chalk.gray,
  dim: chalk.dim,
};

// Reasoning step counter
let stepCounter = 0;

export const ui = {
  /**
   * Reset step counter (call at start of agent execution)
   */
  resetSteps() {
    stepCounter = 0;
  },

  /**
   * Log a reasoning step (like Claude Code)
   */
  step(message: string) {
    stepCounter++;
    console.log(`${theme.accent(`  ${stepCounter}.`)} ${theme.secondary(message)}`);
  },

  /**
   * Log a tool call
   */
  toolCall(toolName: string, input?: string) {
    console.log(theme.muted(`     → ${toolName}`) + (input ? theme.dim(`: ${input}`) : ''));
  },

  /**
   * Log a tool result (success)
   */
  toolResult(summary: string) {
    console.log(theme.success(`     ✓ ${summary}`));
  },

  /**
   * Log a tool error
   */
  toolError(error: string) {
    console.log(theme.error(`     ✗ ${error}`));
  },

  /**
   * Log agent thinking
   */
  thinking(text: string) {
    console.log(theme.dim(`     ${text}`));
  },

  /**
   * Start a new section
   */
  section(title: string) {
    console.log('');
    console.log(theme.primary(`━━━ ${title} ━━━`));
    this.resetSteps();
  },

  /**
   * Section complete
   */
  sectionComplete(summary: string) {
    console.log(theme.success(`✓ ${summary}`));
    console.log('');
  },

  /**
   * Wrapper around clack.spinner with theme
   */
  spinner() {
    return clack.spinner();
  },

  /**
   * Log info (uses clack)
   */
  info(message: string) {
    clack.log.info(theme.muted(message));
  },

  /**
   * Log success (uses clack)
   */
  success(message: string) {
    clack.log.success(theme.success(message));
  },

  /**
   * Log warning (uses clack)
   */
  warn(message: string) {
    clack.log.warn(theme.warning(message));
  },

  /**
   * Log error (uses clack)
   */
  error(message: string) {
    clack.log.error(theme.error(message));
  },
};
