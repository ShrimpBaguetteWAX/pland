import type { ReactNode } from 'react'

/* Line icons drawn on a 24 px grid; they take the colour of the text around them. */

const P: Record<string, ReactNode> = {
  // Shield and globe: the shield from the Divisions icon with a planet inside.
  logo: (
    <>
      <path d="M12 2.8l7 2.6v5.4c0 4.3-3 7.8-7 10.2-4-2.4-7-5.9-7-10.2V5.4z" />
      <circle cx="12" cy="10.8" r="3.4" />
      <path d="M8.6 10.8h6.8" />
    </>
  ),
  army: <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />,
  rocket: (
    <>
      <path d="M9 15l-3-3c2-5 6-8.5 13-9 0 7-4 11-9 13z" />
      <circle cx="14.5" cy="9.5" r="1.6" />
      <path d="M6 15c-1 1-2 4-2 5 1 0 4-1 5-2" />
    </>
  ),
  gift: (
    <>
      <rect x="3.5" y="8.5" width="17" height="12" rx="2" />
      <path d="M3.5 12.5h17M12 8.5v12M12 8.5C10 5 7 5 7 7s5 1.5 5 1.5S17 9 17 7s-3-2-5 1.5" />
    </>
  ),
  flag: <path d="M6 21V4M6 4.5h10l-2 4 2 4H6" />,
  flame: <path d="M12 21c3.5 0 6-2.6 6-6 0-4.5-4-6-4.5-11C10.5 6 9 8.5 9 11c-1-.8-1.5-2-1.5-3.5C6 9.5 6 12 6 15c0 3.4 2.5 6 6 6z" />,
  cart: (
    <>
      <path d="M3 4h2l2 11h11l2-7H6.2" />
      <circle cx="9" cy="19.5" r="1.4" />
      <circle cx="17" cy="19.5" r="1.4" />
    </>
  ),
  spark: <path d="M12 3l2 6.5L20.5 12 14 14l-2 7-2-7-6.5-2L10 9.5z" />,
  weapon: (
    <>
      <path d="M14.5 4.5h5v5l-9 9-5-5z" />
      <path d="M6 15l3 3M4 20l2.5-2.5" />
    </>
  ),
  supply: (
    <>
      <rect x="7" y="3.5" width="10" height="17" rx="3" />
      <path d="M7 9h10M7 15h10" />
    </>
  ),
  creature: (
    <>
      <path d="M6 18c-2-3-1-7 2-9l1-4 3 3 3-3 1 4c3 2 4 6 2 9" />
      <circle cx="10" cy="13" r=".8" fill="currentColor" />
      <circle cx="14" cy="13" r=".8" fill="currentColor" />
    </>
  ),
  lavalux: (
    <>
      <path d="M12 3c3 4 6 7 6 11a6 6 0 01-12 0c0-4 3-7 6-11z" />
      <path d="M10 15a2 2 0 004 0" />
    </>
  ),
  atk: (
    <>
      <path d="M14.5 4.5h5v5l-9 9-5-5z" />
      <path d="M6 15l3 3" />
    </>
  ),
  def: <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />,
  move: <path d="M5 12h12M13 7l5 5-5 5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  wallet: (
    <>
      <rect x="3.5" y="6" width="17" height="13" rx="2.5" />
      <path d="M3.5 10h17M16 14.5h1" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M15.5 6.2a3 3 0 010 5.6M17.5 14.8c1.5.6 2.5 2 3 4.2" />
    </>
  )
}

export type IconName = keyof typeof P

export function Icon({ name, size = 18, width = 1.9 }: { name: IconName; size?: number; width?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {P[name]}
    </svg>
  )
}
