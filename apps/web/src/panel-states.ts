/**
 * What the agent panel says when there is no summary to say it from.
 *
 * Three situations reach this: a report link that is not a report, a service
 * that stopped answering, and a scan that failed before it produced anything.
 * All three were written out by hand at their call sites, and two of them
 * forgot the heading, so the page read "Scan in progress" directly above the
 * words "Scan stopped" while step one pulsed forever.
 */

export interface PanelState {
  readonly heading: string;
  readonly status: string;
  readonly phase: string;
  readonly detail: string;
  readonly sign: string;
  /** What a screen reader is told, once. */
  readonly announcement: string;
  /** Whether the verdict banner should carry the same explanation. */
  readonly verdict: string | null;
  /**
   * Whether there is any result to show at all.
   *
   * False keeps whatever is already rendered, which is the whole point of the
   * lost-contact state. True clears the cards, the progress bar and the
   * tables, because a report that does not exist was still rendering an
   * orphan hairline and a grid of zeroes.
   */
  readonly blank: boolean;
}

/** A report id that is not a report, or one that has expired. */
export function reportNotFound(): PanelState {
  return {
    heading: "Report not found",
    status:
      "That report link is not valid, or it has passed its 30 day expiry and been deleted.",
    phase: "Not found",
    detail: "Enter a username above to run a new scan.",
    sign: "Nothing to show",
    announcement: "That report was not found.",
    verdict: null,
    blank: true,
  };
}

/**
 * The service stopped answering, but the report is not gone.
 *
 * Everything already on the page stays. The alternative, which is what this
 * used to do, was to wipe a fully populated ledger and print "that report link
 * is not valid" above it.
 */
export function lostContact(): PanelState {
  return {
    heading: "Lost contact with the service",
    status:
      "The service stopped answering while this report was loading. Anything already shown below is real. Reload the page to pick it up again.",
    phase: "Lost contact",
    detail: "Reload the page to try again.",
    sign: "Lost contact",
    announcement: "Lost contact with the service. Reload the page to try again.",
    verdict: null,
    // Everything already on the page is real and stays.
    blank: false,
  };
}

/** A scan that failed before it produced a single summary. */
export function couldNotStart(why: string): PanelState {
  return {
    heading: "Scan stopped early",
    status: `Scan stopped. ${why}`,
    phase: "Stopped",
    detail: why,
    sign: "Stopped",
    announcement: `Scan stopped. ${why}`,
    verdict: `This scan could not start. ${why}`,
    blank: true,
  };
}
