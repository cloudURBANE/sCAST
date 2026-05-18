import React from 'react';
import { Wind } from 'lucide-react';
import { LavaBackground } from '@/components/LavaBackground';
import { APP_BRAND_MARK } from '@/lib/appBrand';
import { CommunityHero } from '@/components/community/CommunityHero';
import { BottleMarquee } from '@/components/community/BottleMarquee';
import { FeaturedCaseGrid } from '@/components/community/FeaturedCaseGrid';
import { useCommunityFragrances } from '@/components/community/communityData';

interface CommunityPageProps {
  authToken: string | null;
}

export const CommunityPage: React.FC<CommunityPageProps> = ({ authToken: _authToken }) => {
  const { data, isLoading } = useCommunityFragrances();

  return (
    <div className="scent-app-shell min-h-[100svh] bg-scent-bg selection:bg-scent-accent selection:text-black text-white relative overflow-x-hidden">
      <LavaBackground />
      <nav className="scent-topbar fixed top-0 left-0 right-0 h-16 sm:h-[72px] z-50 px-3 sm:px-8">
        <div className="max-w-[1760px] mx-auto h-full relative flex items-center justify-center">
          <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center gap-3 sm:gap-4">
            <a href="/" className="text-[9px] sm:text-xs uppercase tracking-[0.2em] text-[#f4debd]/70 hover:text-white transition-colors whitespace-nowrap">
              Home
            </a>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 pointer-events-none">
            <Wind
              strokeWidth={1.25}
              className="w-[19.8px] h-[19.8px] sm:w-[22px] sm:h-[22px] text-scent-accent drop-shadow-[0_0_10px_rgba(201,139,44,0.22)]"
            />
            <h1 className="scent-brandmark font-serif text-[1.125rem] sm:text-3xl tracking-[0.14em] uppercase">{APP_BRAND_MARK}</h1>
          </div>
          <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-3 sm:gap-4 justify-end">
            <span className="text-[10px] sm:text-xs uppercase tracking-[0.2em] text-scent-accent whitespace-nowrap">Community</span>
          </div>
        </div>
      </nav>

      <div className="pt-16 sm:pt-[72px]" />

      <main className="relative z-10 pb-24 px-4 sm:px-8 max-w-[1760px] mx-auto">
        <div className="space-y-20 sm:space-y-28 pt-10 sm:pt-14">
          <CommunityHero />
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
