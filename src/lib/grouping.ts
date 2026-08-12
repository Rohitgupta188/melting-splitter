import { ParsedRow } from "./types";

export interface GroupedData {
  kt: string;
  color: string;
  groupName: string; // e.g., "14KT R"
  items: ParsedRow[];
  totalQty: number;
  totalGrossWt: number;
  totalNetWt: number;
  totalStoneWt: number;
}

/**
 * Groups an array of ParsedRows by KT and Color.
 */
export function groupRows(rows: ParsedRow[]): GroupedData[] {
  const groups = new Map<string, GroupedData>();

  for (const row of rows) {
    const groupName = `${row.kt}KT ${row.color}`;

    if (!groups.has(groupName)) {
      groups.set(groupName, {
        kt: row.kt,
        color: row.color,
        groupName,
        items: [],
        totalQty: 0,
        totalGrossWt: 0,
        totalNetWt: 0,
        totalStoneWt: 0,
      });
    }

    const group = groups.get(groupName)!;
    group.items.push(row);
    group.totalQty     += row.qty;
    group.totalGrossWt += row.grossWeight * row.qty;
    group.totalNetWt   += row.netWeight   * row.qty;
    group.totalStoneWt += row.stoneWeight * row.qty;
  }

  return Array.from(groups.values());
}

