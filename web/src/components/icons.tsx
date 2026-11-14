import type { ReactNode } from "react";

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const ChevronRight = () => (
  <Icon>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Icon>
);
export const ChevronDown = () => (
  <Icon>
    <path d="M3.5 6 8 10.5 12.5 6" />
  </Icon>
);
export const FileIcon = () => (
  <Icon>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M9 1.75v3h3" />
  </Icon>
);
export const FolderIcon = () => (
  <Icon>
    <path d="M1.75 4.25v8.5h12.5v-7h-6l-1.5-1.5z" />
  </Icon>
);
export const NewFileIcon = () => (
  <Icon>
    <path d="M9 1.75H4v12.5h4" />
    <path d="M9 1.75l3 3V8M9 1.75v3h3M12 10.5v4M10 12.5h4" />
  </Icon>
);
export const NewFolderIcon = () => (
  <Icon>
    <path d="M8 12.75H1.75v-8.5h5l1.5 1.5h6V8" />
    <path d="M12 10.5v4M10 12.5h4" />
  </Icon>
);
export const PlayIcon = () => (
  <Icon>
    <path d="M4.5 2.75v10.5l8.5-5.25z" fill="currentColor" />
  </Icon>
);
export const CopyIcon = () => (
  <Icon>
    <rect x="5.25" y="5.25" width="8" height="8" rx="1.5" />
    <path d="M10.75 5.25v-1.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.5" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Icon>
);
export const MoreIcon = () => (
  <Icon>
    <circle cx="3.5" cy="8" r="0.9" fill="currentColor" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.9" fill="currentColor" />
  </Icon>
);
export const TrashIcon = () => (
  <Icon size={14}>
    <path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4.25 4.25l.5 9h6.5l.5-9" />
  </Icon>
);
export const PencilIcon = () => (
  <Icon size={14}>
    <path d="m2.5 13.5.6-3 7.9-7.9 2.4 2.4-7.9 7.9z" />
  </Icon>
);
export const KeyboardIcon = () => (
  <Icon size={14}>
    <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
    <path d="M4 6.75h.01M6.67 6.75h.01M9.33 6.75h.01M12 6.75h.01M4.5 9.5h7" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);
