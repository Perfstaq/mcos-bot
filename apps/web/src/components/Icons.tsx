/** Inline, currentColor, 1.6 stroke. No icon dependency for eleven glyphs. */
type Props = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const IconMeetings = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <rect x="2.5" y="4.5" width="15" height="12" rx="2.5" />
    <path d="M2.5 8.5h15M7 2.5v3M13 2.5v3" />
  </svg>
);

export const IconReview = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M2.5 11.5h4l1.5 2.5h4l1.5-2.5h4" />
    <path d="M4.2 4.2 2.5 11.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3l-1.7-7.3a2 2 0 0 0-1.95-1.5H6.15a2 2 0 0 0-1.95 1.5Z" />
  </svg>
);

export const IconBrief = ({ size = 18 }: Props) => (
  <svg {...base(size)}>
    <path d="M4.5 2.5h7l4 4v11a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z" />
    <path d="M11.5 2.5v4h4M7 10.5h6M7 13.5h4" />
  </svg>
);

export const IconCheck = ({ size = 16 }: Props) => (
  <svg {...base(size)}><path d="M4 10.5 8 14.5l8-9" /></svg>
);

export const IconX = ({ size = 16 }: Props) => (
  <svg {...base(size)}><path d="M5 5l10 10M15 5 5 15" /></svg>
);

export const IconPencil = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M13.5 3.5a2.1 2.1 0 0 1 3 3L7 16l-4 1 1-4Z" />
  </svg>
);

export const IconRetry = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M17 10a7 7 0 1 1-2.1-5" /><path d="M17 2.5V6h-3.5" />
  </svg>
);

export const IconChevron = ({ size = 16 }: Props) => (
  <svg {...base(size)}><path d="M7.5 4.5 13 10l-5.5 5.5" /></svg>
);

export const IconQuote = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M8 5.5C5.5 6.5 4 8.5 4 11v3.5h4.5V10H6.5c0-1.6.6-2.8 1.5-3.4ZM17 5.5c-2.5 1-4 3-4 5.5v3.5h4.5V10h-2c0-1.6.6-2.8 1.5-3.4Z" />
  </svg>
);

export const IconLink = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <path d="M8.5 11.5a3 3 0 0 0 4.3 0l2.7-2.7a3 3 0 0 0-4.3-4.3l-1.4 1.4" />
    <path d="M11.5 8.5a3 3 0 0 0-4.3 0l-2.7 2.7a3 3 0 0 0 4.3 4.3l1.4-1.4" />
  </svg>
);

export const IconPlus = ({ size = 16 }: Props) => (
  <svg {...base(size)}><path d="M10 4v12M4 10h12" /></svg>
);

export const IconTrash = ({ size = 16 }: Props) => (
  <svg {...base(size)}>
    <path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.5 5.5l.7 10a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-10" />
  </svg>
);
