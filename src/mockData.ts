export const balanceSnapshot = {
  net: '+P3,240',
  collect: 'P5,180',
  settle: 'P1,940',
}

export const quickActions = [
  { title: 'Add bill', detail: 'Restaurant, utilities, or debt' },
  { title: 'New group', detail: 'Invite housemates or friends' },
  { title: 'Settle up', detail: 'Turn balances into payments' },
]

export const groupSummaries = [
  {
    name: 'Baguio Food Trip',
    members: 5,
    net: '+P2,150',
    status: 'On track',
    initials: ['A', 'J', 'M'],
  },
  {
    name: 'Apartment Utilities',
    members: 3,
    net: '-P860',
    status: 'Due soon',
    initials: ['K', 'R', 'S'],
  },
  {
    name: 'Weekend Coffee Run',
    members: 4,
    net: '+P420',
    status: '1 payment pending',
    initials: ['L', 'T', 'N'],
  },
]

export const activities = [
  {
    title: 'Samgyup dinner',
    subtitle: 'You logged 5 items and split them across 4 friends',
    amount: '+P1,840',
  },
  {
    title: 'Internet bill',
    subtitle: 'Apartment Utilities is due in 2 days',
    amount: '-P650',
  },
  {
    title: 'Mika settled up',
    subtitle: 'Your balance increased after a completed payment',
    amount: '+P420',
  },
]

export const ledgerRows = [
  {
    title: 'Korean BBQ dinner',
    group: 'Baguio Food Trip',
    date: 'Today',
    items: 5,
    state: 'To collect',
    amount: 'P1,840',
  },
  {
    title: 'Apartment internet',
    group: 'Apartment Utilities',
    date: 'Tomorrow',
    items: 1,
    state: 'To settle',
    amount: 'P650',
  },
  {
    title: 'Coffee beans order',
    group: 'Weekend Coffee Run',
    date: 'Fri',
    items: 3,
    state: 'To collect',
    amount: 'P420',
  },
]

export const settlementQueue = [
  { person: 'Mika', summary: 'Send reminder for P420', status: 'Ready to collect' },
  { person: 'Jules', summary: 'Utilities share P650 due tomorrow', status: 'Needs settling' },
  { person: 'Anna', summary: 'Trip snacks P320 pending', status: 'Review split' },
]
