import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {children}
    </svg>
  );
}

export function LogoMark(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M12 21c4.5-4.56 6.75-8.2 6.75-10.91A6.75 6.75 0 1 0 5.25 10.1C5.25 12.8 7.5 16.44 12 21Z"
        fill="currentColor"
      />
      <path
        d="M8.35 10.1a3.65 3.65 0 0 1 7.3 0"
        stroke="white"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
      <path
        d="m9.45 10.35 1.7 1.7 3.45-3.5"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </IconBase>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="10.8" cy="10.8" r="6.8" stroke="currentColor" strokeWidth="2" />
      <path d="m16 16 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </IconBase>
  );
}

export function LocationIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M12 21c4.25-4.2 6.4-7.7 6.4-10.5a6.4 6.4 0 1 0-12.8 0C5.6 13.3 7.75 16.8 12 21Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <circle cx="12" cy="10.4" r="2.25" stroke="currentColor" strokeWidth="1.8" />
    </IconBase>
  );
}

export function TargetIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7 3.5h6l4 4V20H7V3.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M13 3.5v4h4M9.5 12h5M9.5 15.5h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 12.5 4.2 4.2L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6.5 6.5 11 11m0-11-11 11" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function ArrowIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M13 5h6v6M19 5l-8 8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function MapIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m4 5 5-2 6 2 5-2v16l-5 2-6-2-5 2V5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M9 3v16M15 5v16" stroke="currentColor" strokeWidth="1.7" />
    </IconBase>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1" fill="currentColor" />
    </IconBase>
  );
}

export function CarIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 11 1.4-4h11.2l1.4 4 1.5 1.5V18h-2v-2h-13v2h-2v-5.5L5 11Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
      <circle cx="7" cy="13" r="1" fill="currentColor" />
      <circle cx="17" cy="13" r="1" fill="currentColor" />
    </IconBase>
  );
}

export function TransitIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="5" y="3" width="14" height="16" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5 12h14M8 7h8M8 21l2-2m6 0 2 2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
      <circle cx="8.5" cy="15.5" r="1" fill="currentColor" />
      <circle cx="15.5" cy="15.5" r="1" fill="currentColor" />
    </IconBase>
  );
}

export function BikeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="6" cy="16" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="18" cy="16" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m6 16 4-7 3 7m-7 0h7l5-7h-4M9 6h3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </IconBase>
  );
}

export function ScooterIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="6.5" cy="17" r="3" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="18" cy="17" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9.5 17h3.5l2-4h-4.5l-2.5-4H5.5M15 13l1.5-6H20M17 7h3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </IconBase>
  );
}

export function WalkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="13" cy="4.5" r="2" fill="currentColor" />
      <path d="m10.5 9 3-1 2.5 3 2.5 1M13.5 8l-1 5 3 3.5 1 4M12.5 13l-3 3-2 4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </IconBase>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 2c.8 5.3 4.1 8.5 9 9-4.9.5-8.2 3.7-9 9-.8-5.3-4.1-8.5-9-9 4.9-.5 8.2-3.7 9-9Z" fill="currentColor" />
    </IconBase>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3 5.5 5.6v5.6c0 4.1 2.6 7.8 6.5 9.8 3.9-2 6.5-5.7 6.5-9.8V5.6L12 3Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="m9 12 2 2 4-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </IconBase>
  );
}

export function HeartIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20.5 9.5c0 4.8-8.5 10-8.5 10s-8.5-5.2-8.5-10A4.5 4.5 0 0 1 12 7.4a4.5 4.5 0 0 1 8.5 2.1Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </IconBase>
  );
}
