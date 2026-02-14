
export enum AppStep {
  HOME = 'HOME',
  DETAILS = 'DETAILS',
  RECORDING = 'RECORDING',
  FINISHED = 'FINISHED'
}

export interface Attendee {
  id: string;
  name: string;
  email: string;
  department: string;
}

export interface MeetingData {
  title: string;
  type: string;
  attendees: Attendee[];
  transcription: string[];
  startTime?: Date;
}

export const MEETING_TYPES = [
  "Client - Initial assessment",
  "Client - Design stage kick off",
  "Client - Mid way meeting",
  "Client - Handover meeting",
  "Internal - Team meeting",
  "Internal - Project review",
  "Internal - Other"
];
