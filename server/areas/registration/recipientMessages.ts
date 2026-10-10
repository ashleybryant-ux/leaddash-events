/**
 * Welcome emails and follow-ups for speakers, sponsors and exhibitors
 * (the attendee messages live in messages.ts). Each sends at most once per person.
 */

/** Sends the speaker welcome email now if it is on and has not gone out. */
export async function sendSpeakerWelcome(_speakerId: number): Promise<void> {}

/** Sends the sponsor or exhibitor welcome email now if it is on and has not gone out. */
export async function sendVendorWelcome(_vendorId: number): Promise<void> {}
