import { LayoutDashboard, Users, History, Settings } from 'lucide-react';
import { Attendee } from './types';

export const DEPARTMENTS = [
  "Innovation Coaches",
  "Designer",
  "Administrators",
  "Business Support",
  "Researchers and IP"
];

export const MEETING_TYPES = [
  { id: 'strategy', label: 'Strategy', icon: LayoutDashboard, description: 'High-level planning and roadmap sessions.' },
  { id: 'workshop', label: 'Workshop', icon: Users, description: 'Collaborative ideation and problem-solving.' },
  { id: 'review', label: 'Review', icon: History, description: 'Project milestones and feedback sessions.' },
  { id: 'admin', label: 'Admin', icon: Settings, description: 'Internal team syncs and logistics.' },
];

export const ALL_ATTENDEES: Attendee[] = [
  // Innovation Coaches
  { id: '1', name: 'Alexander Bell', email: 'alex.bell@innovate-design.com', department: 'Innovation Coaches' },
  { id: '2', name: 'Emma Farrow-Thomas', email: 'Emma.Farrow-Thomas@innovate-design.com', department: 'Innovation Coaches' },
  { id: '3', name: 'Helen Smartt', email: 'helen.smartt@innovate-design.com', department: 'Innovation Coaches' },
  { id: '4', name: 'Jean-Philippe Chameaux', email: 'Jean-Philippe.Chameaux@innovate-design.com', department: 'Innovation Coaches' },
  { id: '5', name: 'Sam Smith', email: 'sam.smith@innovate-design.com', department: 'Innovation Coaches' },
  { id: '6', name: 'Thomas Kelly', email: 'thomas.kelly@innovate-design.com', department: 'Innovation Coaches' },

  // Designers
  { id: '8', name: 'Adam Davies', email: 'adam.davies@innovate-design.com', department: 'Designer' },
  { id: '9', name: 'Alex Gunning', email: 'alex.gunning@innovate-design.com', department: 'Designer' },
  { id: '10', name: 'Ben Shutler', email: 'ben.shutler@innovate-design.com', department: 'Designer' },
  { id: '11', name: 'Donna Bennett', email: 'donna.bennett@innovate-design.com', department: 'Designer' },
  { id: '12', name: 'Emily Avant', email: 'emily.avant@innovate-design.com', department: 'Designer' },
  { id: '13', name: 'Gabriel Davies', email: 'Gabriel.Davies@innovate-design.com', department: 'Designer' },
  { id: '14', name: 'Hoo Kim', email: 'hoo.kim@innovate-design.com', department: 'Designer' },
  { id: '15', name: 'James McInerny', email: 'james.mcinerny@innovate-design.com', department: 'Designer' },
  { id: '16', name: 'Junn Mendoza', email: 'Junn.Mendoza@innovate-design.com', department: 'Designer' },
  { id: '17', name: 'Nick Radford', email: 'nick.radford@innovate-design.co.uk', department: 'Designer' },
  { id: '18', name: 'Peter Lidstone-Scott', email: 'peter.lidstone-scott@innovate-design.com', department: 'Designer' },
  { id: '19', name: 'Sally Usher', email: 'Sally.Usher@innovate-design.com', department: 'Designer' },
  { id: '20', name: 'Sean Irving', email: 'sean.irving@innovate-design.com', department: 'Designer' },

  // Administrators
  { id: '21', name: 'Anouk Boukhemal', email: 'anouk.boukhemal@innovate-design.com', department: 'Administrators' },
  { id: '22', name: 'Lucy Penfold', email: 'lucy.penfold@innovate-design.com', department: 'Administrators' },

  // Business Support
  { id: '23', name: 'Barbara Bouffard', email: 'barbara@innovate-design.com', department: 'Business Support' },
  { id: '24', name: 'Grace Doughty', email: 'grace.doughty@innovate-design.com', department: 'Business Support' },

  // Researchers and IP
  { id: '25', name: 'Beverley Maloney', email: 'beverley.maloney@innovate-design.com', department: 'Researchers and IP' },
  { id: '26', name: 'Debbie Bowman', email: 'Debbie.Bowman@innovate-design.com', department: 'Researchers and IP' },
  { id: '27', name: 'Kevin Cope', email: 'kevin.cope@innovate-design.com', department: 'Researchers and IP' },
  { id: '7', name: 'Timothy Mount', email: 'tim@innovate-design.com', department: 'Researchers and IP' },
  { id: '28', name: 'Toby King', email: 'toby.king@innovate-design.co.uk', department: 'Researchers and IP' },
  { id: '29', name: 'Valerie Plaud', email: 'valerie.plaud@innovate-design.co.uk', department: 'Researchers and IP' }
];
