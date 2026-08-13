import { ParsedRow } from "./types";

export interface GroupedData {
  kt?: string;
  color?: string;
  groupName: string; // e.g., "14KT R" or "Rings"
  items: ParsedRow[];
  totalQty: number;
  totalGrossWt: number;
  totalNetWt: number;
  totalStoneWt: number;
  selected?: boolean;
}

export type SplitMode = "melting" | "category";

/**
 * Groups an array of ParsedRows based on the chosen split mode.
 */
export function groupRows(rows: ParsedRow[], mode: SplitMode = "melting"): GroupedData[] {
  const groups = new Map<string, GroupedData>();

  for (const row of rows) {
    let groupName = "";
    let kt: string | undefined;
    let color: string | undefined;

    if (mode === "category") {
      groupName = row.itemType || "Unknown Category";
    } else {
      groupName = `${row.kt}KT ${row.color}`;
      kt = row.kt;
      color = row.color;
    }

    if (!groups.has(groupName)) {
      groups.set(groupName, {
        kt,
        color,
        groupName,
        items: [],
        totalQty: 0,
        totalGrossWt: 0,
        totalNetWt: 0,
        totalStoneWt: 0,
        selected: true, // all groups are selected by default for PDF generation
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

