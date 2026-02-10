import { LayoutDashboard, Users, History, Settings } from 'lucide-react';
import { Attendee } from './types';

export const DEPARTMENTS = [
  'Innovation Coaches',
  'Designers',
  'Admin',
  'Business Support',
  'Researchers/IP'
] as const;

export const MEETING_TYPES = [
  { id: 'strategy', label: 'Strategy', icon: LayoutDashboard, description: 'High-level planning and roadmap sessions.' },
  { id: 'workshop', label: 'Workshop', icon: Users, description: 'Collaborative ideation and problem-solving.' },
  { id: 'review', label: 'Review', icon: History, description: 'Project milestones and feedback sessions.' },
  { id: 'admin', label: 'Admin', icon: Settings, description: 'Internal team syncs and logistics.' },
];

export const ALL_ATTENDEES: Attendee[] = [
  // Innovation Coaches
  { id: '1', name: 'Alun James', email: 'alun.james@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '2', name: 'James Dyson', email: 'james.dyson@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '3', name: 'Phil Staunton', email: 'phil.staunton@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '4', name: 'Molly Staunton', email: 'molly.staunton@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '5', name: 'Stephen King', email: 'stephen.king@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '6', name: 'Mark Sheahan', email: 'mark.sheahan@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '7', name: 'Stephen Langford', email: 'stephen.langford@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '8', name: 'Clare Staunton', email: 'clare.staunton@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '9', name: 'Alastair James', email: 'alastair.james@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '10', name: 'Ravi', email: 'ravi@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '11', name: 'Toby Carr', email: 'toby.carr@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '12', name: 'Rory', email: 'rory@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '13', name: 'Ffion Staunton', email: 'ffion.staunton@innovate-design.co.uk', department: 'Innovation Coaches' },
  { id: '14', name: 'Kevin Cope', email: 'kevin.cope@innovate-design.co.uk', department: 'Innovation Coaches' },

  // Designers
  { id: '15', name: 'Phil Staunton (D)', email: 'phil.staunton@innovate-design.co.uk', department: 'Designers' },
  { id: '16', name: 'George', email: 'george@innovate-design.co.uk', department: 'Designers' },
  { id: '17', name: 'Tom', email: 'tom@innovate-design.co.uk', department: 'Designers' },
  { id: '18', name: 'Niall', email: 'niall@innovate-design.co.uk', department: 'Designers' },
  { id: '19', name: 'Jacob', email: 'jacob@innovate-design.co.uk', department: 'Designers' },
  { id: '20', name: 'Ines', email: 'ines@innovate-design.co.uk', department: 'Designers' },
  { id: '21', name: 'Harry', email: 'harry@innovate-design.co.uk', department: 'Designers' },
  { id: '22', name: 'Chris', email: 'chris@innovate-design.co.uk', department: 'Designers' },
  { id: '23', name: 'Elias', email: 'elias@innovate-design.co.uk', department: 'Designers' },
  { id: '24', name: 'Willie', email: 'willie@innovate-design.co.uk', department: 'Designers' },
  { id: '25', name: 'Aswin', email: 'aswin@innovate-design.co.uk', department: 'Designers' },
  { id: '26', name: 'Callum', email: 'callum@innovate-design.co.uk', department: 'Designers' },

  // Admin
  { id: '27', name: 'Wendy James', email: 'wendy.james@innovate-design.co.uk', department: 'Admin' },
  { id: '28', name: 'Clare Staunton (A)', email: 'clare.staunton@innovate-design.co.uk', department: 'Admin' },
  { id: '29', name: 'Gillian', email: 'gillian@innovate-design.co.uk', department: 'Admin' },

  // Business Support
  { id: '30', name: 'Kirsty Carr', email: 'kirsty.carr@innovate-design.co.uk', department: 'Business Support' },
  { id: '31', name: 'Holly Carr', email: 'holly.carr@innovate-design.co.uk', department: 'Business Support' },
  { id: '32', name: 'Toria', email: 'toria@innovate-design.co.uk', department: 'Business Support' },
  { id: '33', name: 'Anna', email: 'anna@innovate-design.co.uk', department: 'Business Support' },
  { id: '34', name: 'Zoe', email: 'zoe@innovate-design.co.uk', department: 'Business Support' },

  // Researchers/IP
  { id: '35', name: 'James Dyson (R)', email: 'james.dyson@innovate-design.co.uk', department: 'Researchers/IP' },
  { id: '36', name: 'Toby J', email: 'toby.j@innovate-design.co.uk', department: 'Researchers/IP' },
  { id: '37', name: 'Bryn James', email: 'bryn.james@innovate-design.co.uk', department: 'Researchers/IP' },
];
