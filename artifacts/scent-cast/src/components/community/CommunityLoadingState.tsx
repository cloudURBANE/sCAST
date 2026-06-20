interface CommunityLoadingStateProps {
  label?: string;
  className?: string;
}

export function CommunityLoadingState({
  label = 'Loading community',
  className = 'py-20',
}: CommunityLoadingStateProps) {
  return (
    <div
      className={`mx-auto flex w-full max-w-[940px] items-center justify-center ${className}`}
      aria-label={label}
    >
      <div className="h-8 w-8 rounded-full border border-white/15 border-t-scent-accent animate-spin" />
    </div>
  );
}
