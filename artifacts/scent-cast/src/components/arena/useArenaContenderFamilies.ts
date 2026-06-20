import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getFragranceDetails,
  searchFragrances,
  type FragranceDetailRequestPayload,
  type FragranceSearchResult,
} from "@/lib/fragranceApi";
import { sanitizeFamilyLabel } from "@/lib/wardrobeSearchSuggest";
import type { ArenaBattle, ArenaBattleSide } from "@/components/arena/arenaBattleMapper";
import { resolveArenaFamilyFromDetail } from "@/components/arena/arenaFamilyResolver";

const FAMILY_FALLBACKS = new Set(["classic fragrance", "community option"]);

function stableFragranceId(brand: string | undefined, name: string): string {
  const part = (value: string) =>
    value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `catalog:${part(brand || "unknown")}:${part(name)}`;
}

function hasRealFamily(side: ArenaBattleSide): boolean {
  return Boolean(side.family || !FAMILY_FALLBACKS.has(side.descriptor.trim().toLowerCase()));
}

async function familyForPayload(payload: FragranceDetailRequestPayload, signal?: AbortSignal): Promise<string | null> {
  const detail = await getFragranceDetails(payload, { signal });
  return resolveArenaFamilyFromDetail(detail);
}

function detailPayloadForSearchResult(result: FragranceSearchResult): FragranceDetailRequestPayload {
  return {
    id: result.id,
    ...(result.source_url ? { source_url: result.source_url } : {}),
    ...(result.origin ? { origin: result.origin } : {}),
  };
}

async function tryFamilyForPayload(payload: FragranceDetailRequestPayload, signal?: AbortSignal): Promise<string | null> {
  try {
    return await familyForPayload(payload, signal);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return null;
  }
}

async function fetchFamily(side: ArenaBattleSide, signal?: AbortSignal): Promise<string | null> {
  const id = side.fragranceId?.trim() || stableFragranceId(side.brand, side.name);
  const direct = await tryFamilyForPayload({ id, origin: "app", recover_incomplete: true }, signal);
  if (direct) return direct;

  const query = [side.brand, side.name].filter(Boolean).join(" ").trim() || side.name;
  const search = await searchFragrances(query, { signal });
  const best = search.results.find((result) => {
    const resultName = result.name.trim().toLowerCase();
    const resultHouse = (result.house || result.brand || "").trim().toLowerCase();
    const nameMatches = resultName === side.name.trim().toLowerCase();
    const brandMatches = !side.brand || resultHouse === side.brand.trim().toLowerCase();
    return nameMatches && brandMatches;
  }) ?? search.results[0];

  return best ? tryFamilyForPayload(detailPayloadForSearchResult(best), signal) : null;
}

function useContenderFamily(side: ArenaBattleSide) {
  const cleanId = side.fragranceId?.trim();
  return useQuery({
    queryKey: ["arena", "contender-family", cleanId || side.brand || "", side.name],
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
