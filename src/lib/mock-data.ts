// Placeholder card data for the Cards screen. Everything else comes from the Tappi API; there is
// no card issuing yet (accepting or issuing bank cards is still undecided).

export const physicalCard = {
  number: '1253 5432 3521 3090',
  holder: 'Tappi User',
  expiry: '09/29',
};

export type LinkedCard = { id: string; name: string; network: 'VISA' | 'Mastercard'; last4: string };

export const linkedCards: LinkedCard[] = [
  { id: 'k1', name: 'Tappi Virtual', network: 'VISA', last4: '4821' },
  { id: 'k2', name: 'GTBank Debit', network: 'VISA', last4: '7730' },
  { id: 'k3', name: 'Kuda Debit', network: 'Mastercard', last4: '1102' },
];
