import React, { useEffect } from 'react';
import { Wind } from 'lucide-react';
import { AppTopNav } from '@/components/AppTopNav';
import { LavaBackground } from '@/components/LavaBackground';
import { APP_BRAND_MARK } from '@/lib/appBrand';
import { CommunityHero } from '@/components/community/CommunityHero';
import { BottleMarquee } from '@/components/community/BottleMarquee';
import { FeaturedCaseGrid } from '@/components/community/FeaturedCaseGrid';
import { useCommunityFragrances } from '@/components/community/communityData';

interface CommunityPageProps {
  authToken: string | null;
  onSignIn: () => void;
  onShare: () => void;
  onSignOut: () => void;
}

export const CommunityPage: React.FC<CommunityPageProps> = ({ authToken, onSignIn, onShare, onSignOut }) => {
  const { data, isLoading } = useCommunityFragrances();

  useEffect(() => {
    const previous = document.title;
    document.title = 'Community — SCENTBEAM';
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="scent-app-shell min-h-[100svh] bg-scent-bg selection:bg-scent-accent selection:text-black text-white relative overflow-x-hidden">
      <LavaBackground />
      <AppTopNav
        authToken={authToken}
        onSignIn={onSignIn}
        onShare={onShare}
        onSignOut={onSignOut}
      />

      <div className="pt-16 sm:pt-[72px]" />

      <main className="relative z-10 pb-24 px-4 sm:px-8 max-w-[1760px] mx-auto">
        <div className="space-y-20 sm:space-y-28 pt-10 sm:pt-14">
          <CommunityHero />
          <div className="flex items-center gap-4 text-center">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent via-scent-accent/30 to-scent-accent/10" aria-hidden="true" />
            <p className="text-[11px] uppercase tracking-[0.32em] text-scent-muted/80">
              Drifting through the community vault
            </p>
            <span className="h-px flex-1 bg-gradient-to-r from-scent-accent/10 via-scent-accent/30 to-transparent" aria-hidden="true" />
          </div>
          <div className="scent-full-bleed">
            <BottleMarquee items={data ?? []} loading={isLoading} />
          </div>
          <FeaturedCaseGrid items={data ?? []} loading={isLoading} />
        </div>
      </main>

      <footer className="relative z-10 border-t border-scent-accent/10 py-16 px-8 mt-24">
        <div className="max-w-[1400px] mx-auto text-center space-y-4">
          <div className="flex items-center justify-center gap-2 opacity-30">
            <Wind size={18} />
            <p className="font-serif font-bold italic tracking-tighter uppercase">{APP_BRAND_MARK}</p>
          </div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-scent-muted">© 2026 Olfactory Intelligence Systems</p>
        </div>
      </footer>
    </div>
  );
};

export default CommunityPage;
