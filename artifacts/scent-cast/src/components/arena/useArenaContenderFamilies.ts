import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getFragranceDetails,
  resolveMainAccordChartRows,
  type FragranceDetail,
} from "@/lib/fragranceApi";
import { sanitizeFamilyLabel } from "@/lib/wardrobeSearchSuggest";
import type { ArenaBattle, ArenaBattleSide } from "@/components/arena/arenaBattleMapper";

const FAMILY_FALLBACKS = new Set(["classic fragrance", "community option"]);

function stableFragranceId(brand: string | undefined, name: string): string {
  const part = (value: string) =>
    value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `catalog:${part(brand || "unknown")}:${part(name)}`;
}

function hasRealFamily(side: ArenaBattleSide): boolean {
  return Boolean(side.family || !FAMILY_FALLBACKS.has(side.descriptor.trim().toLowerCase()));
}

function familyFromDetail(detail: FragranceDetail): string | null {
  const direct = sanitizeFamilyLabel(detail.family);
  if (direct) return direct;

  const rows = resolveMainAccordChartRows(detail.derived_metrics?.main_accords, null);
  return sanitizeFamilyLabel(rows[0]?.label);
}

async function fetchFamily(side: ArenaBattleSide, signal?: AbortSignal): Promise<string | null> {
  const id = side.fragranceId?.trim() || stableFragranceId(side.brand, side.name);
  const detail = await getFragranceDetails({ id, origin: "app" }, { signal });
  return familyFromDetail(detail);
}

function useContenderFamily(side: ArenaBattleSide) {
  return useQuery({
    queryKey: ["arena", "contender-family", side.fragranceId || side.brand || "", side.name],
    queryFn: ({ signal }) => fetchFamily(side, signal),
    enabled: !hasRealFamily(side),
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
}

export function useArenaContenderFamilies(battle: ArenaBattle): ArenaBattle {
  const leftFamily = useContenderFamily(battle.left);
  const rightFamily = useContenderFamily(battle.right);

  return useMemo(() => {
    const apply = (side: ArenaBattleSide, family: string | null | undefined): ArenaBattleSide => {
      const clean = sanitizeFamilyLabel(family);
      return clean ? { ...side, family: clean, descriptor: clean } : side;
    };
    return {
      ...battle,
      left: apply(battle.left, leftFamily.data),
      right: apply(battle.right, rightFamily.data),
    };
  }, [battle, leftFamily.data, rightFamily.data]);
}
