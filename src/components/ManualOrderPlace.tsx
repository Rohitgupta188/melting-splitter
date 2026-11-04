"use client";

import React, { useState, useMemo, useCallback } from "react";
import {
  FileText,
  Download,
  ExternalLink,
  RotateCcw,
  Clipboard,
  Trash2,
  Layers,
  FileCheck,
  SlidersHorizontal,
  RefreshCw,
  Check,
  Rocket,
  ChevronRight,
  Calendar,
} from "lucide-react";
import { saveAs } from "file-saver";
import { buildProductionPDF, PdfQuotationLineItem } from "@/lib/production";
import { cacheCatalogueImages } from "@/lib/image-service";
import logoImg from "../app/icon.png";
import { ModernDropdown, DropdownOption } from "@/components/ui/modern-dropdown";
import { cn } from "@/lib/utils";

/* ─── Types ─────────────────────────────────────────────────────────── */

export interface ManualOrderItem {
  id: string;
  inputDesign: string;
  normalizedDesign: string;
  matched: boolean;
  imageOnlyMatch?: boolean;
  sku?: string;
  itemType?: string;
  grossWeight: number;
  netWeight: number;
  stoneWeight: number;
  reserved1?: number;
  reserved3?: number;
  metalPurity: string;
  metalType: string;
  imageUrl?: string;
  imageName?: string;
  qty: number;
  remarks?: string;
  recordCount: number;
  selected: boolean;
}

interface OrderMetadata {
  quotationNo: string;
  customerName: string;
  contactName: string;
  address: string;
  date: string;
  remarks: string;
}

/* ─── Constants ─────────────────────────────────────────────────────── */

const SAMPLE_DESIGNS = `DZBL-2916
DZBL-2908
DZBL-3032
DZBL-2947
DZBL-2943
DZBL-2933
DZBL-2880
DZBL-2878
DZBL-2890
DZBL-2881
DZBL-2840`;

const KARAT_OPTIONS: DropdownOption[] = [
  { value: "9", label: "9K" },
  { value: "18", label: "18K" },
  { value: "22", label: "22K" },
];

const COLOR_OPTIONS: DropdownOption[] = [
  { value: "Y", label: "Yellow (Y)", dotColor: "#eab308" },
  { value: "R", label: "Rose (R)", dotColor: "#fb7185" },
  { value: "S", label: "Silver (S)", dotColor: "#94a3b8" },
];

/* ─── Helpers ───────────────────────────────────────────────────────── */

async function getLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(logoImg.src);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.error("Failed to load logo", e);
    return null;
  }
}

/* ─── Styles (inline objects for reliability) ───────────────────────── */

const CARD_STYLE: React.CSSProperties = {
  background: "rgba(14, 20, 34, 0.88)",
  backdropFilter: "blur(20px)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "14px",
  boxShadow: "0 8px 30px rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.05) inset",
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  height: "36px",
  background: "#080d16",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: "8px",
  padding: "0 12px",
  fontSize: "13px",
  color: "#fff",
  fontWeight: 500,
  outline: "none",
  transition: "border-color 0.2s, box-shadow 0.2s",
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: "11px",
  fontWeight: 600,
  color: "#94a3b8",
  marginBottom: "4px",
  letterSpacing: "0.02em",
};

/* ─── Main Component ────────────────────────────────────────────────── */

export function ManualOrderPlace() {
  const [inputText, setInputText] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [step, setStep] = useState<"INPUT" | "COMPLETED">("INPUT");
  const [items, setItems] = useState<ManualOrderItem[]>([]);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [bulkPurity, setBulkPurity] = useState<string>("18");
  const [bulkColor, setBulkColor] = useState<string>("Y");
  const [genTime, setGenTime] = useState<number>(0);

  const [orderDetails, setOrderDetails] = useState<OrderMetadata>({
    quotationNo: `MO-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-01`,
    customerName: "Manual Production Order",
    contactName: "",
    address: "",
    date: new Date().toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }),
    remarks: "",
  });

  const parsedLines = useMemo(() => {
    return inputText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }, [inputText]);

  const duplicateStats = useMemo(() => {
    const counts = new Map<string, number>();
    parsedLines.forEach((line) => {
      const key = line.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const duplicates: string[] = [];
    counts.forEach((count, key) => {
      if (count > 1) duplicates.push(key);
    });
    return {
      total: parsedLines.length,
      unique: counts.size,
      duplicateCount: parsedLines.length - counts.size,
      duplicateKeys: duplicates,
    };
  }, [parsedLines]);

  const totals = useMemo(() => {
    const totalQty = items.reduce((sum, i) => sum + (Number(i.qty) || 1), 0);
    const totalGross = items.reduce((sum, i) => sum + (Number(i.grossWeight) || 0), 0);
    const totalNet = items.reduce((sum, i) => sum + (Number(i.netWeight) || 0), 0);
    return { count: items.length, totalQty: totalQty || items.length, totalGross, totalNet };
  }, [items]);

  /* ── Actions ── */

  const handleRemoveDuplicates = useCallback(() => {
    const seen = new Set<string>();
    const deduplicated: string[] = [];
    parsedLines.forEach((line) => {
      const key = line.toLowerCase();
      if (!seen.has(key)) { seen.add(key); deduplicated.push(line); }
    });
    setInputText(deduplicated.join("\n"));
  }, [parsedLines]);

  const handlePasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setInputText((prev) => (prev ? `${prev}\n${text}` : text));
    } catch { /* clipboard denied */ }
  }, []);

  const handleLoadSample = useCallback(() => setInputText(SAMPLE_DESIGNS), []);

  const handleGenerateProductionOrder = async (
    customPurity?: string, customColor?: string, customDetails?: OrderMetadata
  ) => {
    if (parsedLines.length === 0) return;
    setIsProcessing(true);
    setErrorMessage(null);
    const t0 = performance.now();
    const activePurity = customPurity || bulkPurity || "18";
    const activeColor = customColor || bulkColor || "Y";
    const activeDetails = customDetails || orderDetails;

    try {
      const res = await fetch("/api/manual-order/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ designNumbers: parsedLines }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || "Failed to search MongoDB for designs");
      }
      const data = await res.json();
      const rawItems: ManualOrderItem[] = data.items || [];
      setItems(rawItems);

      const imageUrls = rawItems.map((i) => i.imageUrl).filter(Boolean) as string[];
      if (imageUrls.length > 0) await cacheCatalogueImages(imageUrls);
      const logoBase64 = await getLogoBase64();

      const lineItems: PdfQuotationLineItem[] = rawItems.map((item) => ({
        sku: item.sku || item.normalizedDesign,
        designNumber: item.normalizedDesign || item.inputDesign,
        itemType: item.itemType || "Jewellery",
        grossWeight: Number(item.grossWeight) || 0,
        netWeight: Number(item.netWeight) || 0,
        stoneWeight: Number(item.stoneWeight) || 0,
        reserved1: Number(item.reserved1) || 0,
        reserved3: Number(item.reserved3) || 0,
        metalPurity: activePurity,
        metalType: activeColor,
        imageUrl: item.imageUrl || undefined,
        qty: Number(item.qty) || 1,
        remarks: item.remarks || "",
      }));

      const blob = await buildProductionPDF({
        quotationNo: activeDetails.quotationNo || "Quotation",
        companyName: activeDetails.customerName || "Customer",
        contactName: activeDetails.contactName || "",
        address: activeDetails.address || "",
        remarks: activeDetails.remarks || "",
        date: activeDetails.date || new Date().toLocaleDateString(),
        lineItems, logoBase64,
      });

      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      const url = URL.createObjectURL(blob);
      setPdfBlob(blob);
      setPdfUrl(url);
      setGenTime(Number(((performance.now() - t0) / 1000).toFixed(1)));
      setStep("COMPLETED");
    } catch (err: any) {
      console.error("[ManualOrderPlace] Generation error:", err);
      setErrorMessage(err?.message || "Failed to generate production order PDF.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownloadPdf = () => {
    if (pdfBlob) {
      const safeName = (orderDetails.quotationNo || "Production_Order").replace(/[\\/:*?"<>|]/g, "_");
      saveAs(pdfBlob, `${safeName}.pdf`);
    }
  };

  const handleReset = () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setStep("INPUT");
    setInputText("");
    setItems([]);
    setPdfBlob(null);
    setPdfUrl(null);
    setErrorMessage(null);
    setGenTime(0);
  };

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  /*                              RENDER                                */
  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  return (
    <div style={{ width: "100%", maxWidth: "1100px", margin: "0 auto", padding: "0 4px" }}>

      {/* ── STEPPER ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: "12px", margin: "0 auto 14px", maxWidth: "400px",
      }}>
        <button
          type="button"
          onClick={() => step !== "INPUT" && setStep("INPUT")}
          style={{
            display: "flex", alignItems: "center", gap: "8px",
            background: "none", border: "none", cursor: step !== "INPUT" ? "pointer" : "default",
            color: step === "INPUT" ? "#f1cd7b" : "#94a3b8",
          }}
        >
          <div style={{
            width: 26, height: 26, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "11px", fontWeight: 700,
            background: "linear-gradient(135deg, #f1cd7b 0%, #e5ba6b 50%, #c5942a 100%)",
            color: "#1a150b",
            boxShadow: "0 0 14px rgba(216,168,78,0.5)",
          }}>
            {step === "COMPLETED" ? <Check size={13} strokeWidth={3} /> : "1"}
          </div>
          <span style={{ fontSize: "13px", fontWeight: 600, color: step === "INPUT" ? "#f8fafc" : "#94a3b8" }}>
            Input & Details
          </span>
        </button>

        <div style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.12)", minWidth: "60px" }} />

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{
            width: 26, height: 26, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "11px", fontWeight: 700,
            ...(step === "COMPLETED"
              ? { background: "linear-gradient(135deg, #f1cd7b, #c5942a)", color: "#1a150b", boxShadow: "0 0 14px rgba(216,168,78,0.5)" }
              : { background: "#0c1220", border: "1px solid rgba(255,255,255,0.15)", color: "#64748b" }
            ),
          }}>
            2
          </div>
          <span style={{
            fontSize: "13px", fontWeight: step === "COMPLETED" ? 600 : 500,
            color: step === "COMPLETED" ? "#f8fafc" : "#64748b",
          }}>
            Production PDF
          </span>
        </div>
      </div>

      {/* ━━━ STAGE 1: INPUT ━━━ */}
      {step === "INPUT" && (
        <div style={{ width: "100%" }}>
          {/* 2-Column Grid */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "18px",
            alignItems: "stretch",
          }}>
            {/* ── Left Column: Design Numbers ── */}
            <div style={{
              ...CARD_STYLE,
              padding: "18px 20px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}>
              <div>
                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: "8px",
                      background: "rgba(216,168,78,0.12)",
                      border: "1px solid rgba(216,168,78,0.22)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <Layers size={14} color="#d8a84e" />
                    </div>
                    <span style={{ fontSize: "14px", fontWeight: 700, color: "#fff" }}>
                      Design Numbers
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <button
                      type="button"
                      onClick={handleLoadSample}
                      style={{
                        background: "none", border: "none", color: "#94a3b8", fontSize: "11px",
                        cursor: "pointer", padding: "4px 8px", borderRadius: "6px", fontWeight: 500,
                      }}
                      className="hover:text-[#f1cd7b]! hover:bg-[rgba(216,168,78,0.06)]!"
                    >
                      Sample (11)
                    </button>
                    <button
                      type="button"
                      onClick={handlePasteClipboard}
                      style={{
                        background: "none", border: "none", color: "#94a3b8", fontSize: "11px",
                        cursor: "pointer", padding: "4px 8px", borderRadius: "6px", fontWeight: 500,
                        display: "flex", alignItems: "center", gap: "4px",
                      }}
                      className="hover:text-[#f1cd7b]! hover:bg-[rgba(216,168,78,0.06)]!"
                    >
                      <Clipboard size={11} /> Paste
                    </button>
                    {inputText && (
                      <button
                        type="button"
                        onClick={() => setInputText("")}
                        style={{
                          background: "none", border: "none", color: "#64748b", cursor: "pointer",
                          padding: "4px 6px", borderRadius: "6px",
                        }}
                        className="hover:text-[#f87171]! hover:bg-[rgba(248,113,113,0.06)]!"
                        title="Clear all"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Textarea Inset Container */}
                <div style={{
                  background: "#070b13",
                  border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: "10px",
                  padding: "10px 14px",
                }}>
                  <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder={"DZBL- 2916\nDZBL- 2908\nDZBL- 3032\nDZBL- 2947\nDZBL- 2943\nDZBL- 2933\nDZBL- 2880\nDZBL- 2878\nDZBL- 2890\nDZBL- 2881\nDZBL- 2840"}
                    style={{
                      width: "100%",
                      height: "185px",
                      background: "transparent",
                      border: "none",
                      color: "#f1f5f9",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      fontSize: "13px",
                      lineHeight: "1.75",
                      letterSpacing: "0.02em",
                      padding: 0,
                      outline: "none",
                      resize: "none",
                    }}
                  />
                </div>
              </div>

              {/* Footer */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginTop: "10px", paddingTop: "8px",
                borderTop: "1px solid rgba(255,255,255,0.06)",
                fontSize: "11px", color: "#64748b",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: "20px", height: "20px", borderRadius: "5px",
                    background: "rgba(216,168,78,0.12)", color: "#d8a84e",
                    fontSize: "10px", fontWeight: 700,
                  }}>
                    {parsedLines.length}
                  </span>
                  <span style={{ fontWeight: 500, color: "#94a3b8" }}>designs</span>
                </div>

                {duplicateStats.duplicateCount > 0 ? (
                  <button
                    type="button"
                    onClick={handleRemoveDuplicates}
                    style={{
                      background: "none", border: "none", color: "#d8a84e",
                      fontWeight: 600, fontSize: "11px", cursor: "pointer",
                    }}
                  >
                    Remove {duplicateStats.duplicateCount} duplicate{duplicateStats.duplicateCount > 1 ? "s" : ""}
                  </button>
                ) : parsedLines.length > 0 ? (
                  <span style={{ color: "#475569", fontSize: "10px" }}>No duplicates</span>
                ) : null}
              </div>
            </div>

            {/* ── Right Column: Stacked Cards ── */}
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", justifyContent: "space-between" }}>
              
              {/* Card 1: Order Details */}
              <div style={{ ...CARD_STYLE, padding: "16px 18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: "7px",
                    background: "rgba(216,168,78,0.12)",
                    border: "1px solid rgba(216,168,78,0.22)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <FileText size={13} color="#d8a84e" />
                  </div>
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "#fff" }}>
                    Order Details
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 12px" }}>
                
                  <div>
                    <label style={LABEL_STYLE}>Customer</label>
                    <input
                      value={orderDetails.customerName}
                      onChange={(e) => setOrderDetails({ ...orderDetails, customerName: e.target.value })}
                      placeholder="Customer Name"
                      style={INPUT_STYLE}
                    />
                  </div>
                  <div>
                    <label style={LABEL_STYLE}>Date</label>
                    <div style={{ position: "relative" }}>
                      <input
                        value={orderDetails.date}
                        onChange={(e) => setOrderDetails({ ...orderDetails, date: e.target.value })}
                        style={{ ...INPUT_STYLE, paddingLeft: "32px" }}
                      />
                      <Calendar
                        size={13}
                        color="#64748b"
                        style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
                      />
                    </div>
                  </div>
                  <div>
                    <label style={LABEL_STYLE}>Remarks</label>
                    <input
                      value={orderDetails.remarks}
                      onChange={(e) => setOrderDetails({ ...orderDetails, remarks: e.target.value })}
                      placeholder="e.g. Urgent"
                      style={INPUT_STYLE}
                    />
                  </div>
                </div>
              </div>

              {/* Card 2: Bulk Actions */}
              <div style={{ ...CARD_STYLE, padding: "16px 18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: "7px",
                    background: "rgba(216,168,78,0.12)",
                    border: "1px solid rgba(216,168,78,0.22)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <SlidersHorizontal size={13} color="#d8a84e" />
                  </div>
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "#fff" }}>
                    Bulk Actions
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div>
                    <label style={LABEL_STYLE}>Karat (KT)</label>
                    <ModernDropdown
                      value={bulkPurity}
                      onChange={setBulkPurity}
                      options={KARAT_OPTIONS}
                      height="36px"
                    />
                  </div>
                  <div>
                    <label style={LABEL_STYLE}>Color</label>
                    <ModernDropdown
                      value={bulkColor}
                      onChange={setBulkColor}
                      options={COLOR_OPTIONS}
                      height="36px"
                    />
                  </div>
                </div>
              </div>

            </div>
          </div>

          {/* ── Primary CTA Button (Centered at bottom) ── */}
          <div style={{ display: "flex", justifyContent: "center", marginTop: "16px", marginBottom: "2px" }}>
            <button
              id="btn-generate-production-pdf"
              type="button"
              disabled={parsedLines.length === 0 || isProcessing}
              onClick={() => handleGenerateProductionOrder()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                borderRadius: "9999px",
                padding: "12px 42px",
                fontSize: "13.5px",
                fontWeight: 700,
                color: "#1a150b",
                border: "none",
                cursor: (parsedLines.length === 0 || isProcessing) ? "not-allowed" : "pointer",
                background: "linear-gradient(135deg, #f1cd7b 0%, #e5ba6b 50%, #c5942a 100%)",
                boxShadow: "0 4px 22px rgba(216,168,78,0.45)",
                transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
                opacity: (parsedLines.length === 0 || isProcessing) ? 0.35 : 1,
              }}
              className="hover:shadow-[0_6px_30px_rgba(216,168,78,0.65)]! hover:scale-[1.02]! active:scale-[0.98]!"
            >
              {isProcessing ? (
                <>
                  <RefreshCw size={15} className="animate-spin" />
                  <span>Generating…</span>
                </>
              ) : (
                <>
                  <Rocket size={15} />
                  <span>Generate Production PDF</span>
                  <ChevronRight size={16} strokeWidth={2.5} />
                </>
              )}
            </button>
          </div>

          {/* Error */}
          {errorMessage && (
            <div style={{
              marginTop: "12px", padding: "12px 16px", borderRadius: "10px",
              background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
              color: "#fca5a5", fontSize: "13px", display: "flex", alignItems: "center", gap: "10px",
            }}>
              <FileText size={15} />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>
      )}

      {/* ━━━ STAGE 2: COMPLETED ━━━ */}
      {step === "COMPLETED" && (
        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "12px" }}>

          {/* Hero Banner */}
          <div style={{
            ...CARD_STYLE,
            padding: "16px 22px",
            position: "relative",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap" as const,
            gap: "12px",
          }}>
            {/* Top gold line */}
            <div style={{
              position: "absolute", top: 0, left: 0, right: 0, height: "1px",
              background: "linear-gradient(90deg, transparent, rgba(216,168,78,0.6), transparent)",
            }} />
            
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div style={{
                width: 42, height: 42, borderRadius: "10px", flexShrink: 0,
                background: "rgba(216,168,78,0.12)",
                border: "1.5px solid rgba(216,168,78,0.28)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 0 20px rgba(216,168,78,0.2)",
              }}>
                <FileCheck size={20} color="#f1cd7b" />
              </div>
              <div>
                <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#fff", margin: "0 0 2px" }}>
                  Production PDF Ready!
                </h2>
                <p style={{ fontSize: "12px", color: "#94a3b8", margin: 0 }}>
                  Order <span style={{ color: "#f1cd7b", fontWeight: 600 }}>{orderDetails.quotationNo}</span> generated
                  in {genTime}s with {totals.count} items ({totals.totalQty} pieces)
                </p>
              </div>
            </div>

            {/* Status Pill */}
            <div style={{
              display: "inline-flex", alignItems: "center", gap: "6px",
              padding: "5px 12px", borderRadius: "9999px",
              background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.25)",
              color: "#34d399", fontSize: "11px", fontWeight: 600,
            }}>
              <Check size={12} strokeWidth={3} />
              <span>Ready for production</span>
            </div>
          </div>

          {/* Stats Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
            {[
              { label: "Items", value: String(totals.count), gold: false },
              { label: "Pieces", value: String(totals.totalQty), gold: false },
              { label: "Gross Wt", value: `${totals.totalGross.toFixed(3)} g`, gold: true },
              { label: "Net Wt", value: `${totals.totalNet.toFixed(3)} g`, gold: true },
            ].map((s) => (
              <div key={s.label} style={{
                ...CARD_STYLE,
                padding: "12px 14px",
                textAlign: "center" as const,
                ...(s.gold ? { borderColor: "rgba(216,168,78,0.22)" } : {}),
              }}>
                <p style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.1em", color: "#64748b", margin: "0 0 3px" }}>
                  {s.label}
                </p>
                <p style={{ fontSize: "20px", fontWeight: 700, margin: 0, color: s.gold ? "#f1cd7b" : "#fff", letterSpacing: "-0.01em" }}>
                  {s.value}
                </p>
              </div>
            ))}
          </div>

          {/* Order Details & Specs */}
          <div style={{ ...CARD_STYLE, padding: "16px 20px" }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: "10px", paddingBottom: "10px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div style={{
                  width: 24, height: 24, borderRadius: "6px",
                  background: "rgba(216,168,78,0.12)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <SlidersHorizontal size={13} color="#d8a84e" />
                </div>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#fff" }}>Order Details & Specs</span>
              </div>
              <button
                type="button"
                onClick={() => handleGenerateProductionOrder(bulkPurity, bulkColor, orderDetails)}
                disabled={isProcessing}
                style={{
                  background: "none", border: "1px solid rgba(216,168,78,0.25)", color: "#f1cd7b",
                  fontSize: "11px", fontWeight: 600, cursor: isProcessing ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", gap: "5px",
                  padding: "4px 10px", borderRadius: "6px",
                  transition: "all 0.15s",
                }}
                className="hover:bg-[rgba(216,168,78,0.08)]! active:scale-95!"
              >
                <RefreshCw size={11} className={cn(isProcessing && "animate-spin")} />
                Update PDF
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "10px" }}>
              <div>
                <label style={LABEL_STYLE}>Customer</label>
                <input
                  value={orderDetails.customerName}
                  onChange={(e) => setOrderDetails({ ...orderDetails, customerName: e.target.value })}
                  placeholder="Customer Name"
                  style={INPUT_STYLE}
                />
              </div>
              <div>
                <label style={LABEL_STYLE}>Date</label>
                <div style={{ position: "relative" }}>
                  <input
                    value={orderDetails.date}
                    onChange={(e) => setOrderDetails({ ...orderDetails, date: e.target.value })}
                    style={{ ...INPUT_STYLE, paddingLeft: "30px" }}
                  />
                  <Calendar
                    size={12}
                    color="#64748b"
                    style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
                  />
                </div>
              </div>
              <div>
                <label style={LABEL_STYLE}>Remarks</label>
                <input
                  value={orderDetails.remarks}
                  onChange={(e) => setOrderDetails({ ...orderDetails, remarks: e.target.value })}
                  placeholder="e.g. Urgent"
                  style={INPUT_STYLE}
                />
              </div>
              <div>
                <label style={LABEL_STYLE}>Karat</label>
                <ModernDropdown
                  value={bulkPurity}
                  onChange={setBulkPurity}
                  options={KARAT_OPTIONS}
                  height="36px"
                />
              </div>
              <div>
                <label style={LABEL_STYLE}>Color</label>
                <ModernDropdown
                  value={bulkColor}
                  onChange={setBulkColor}
                  options={COLOR_OPTIONS}
                  height="36px"
                />
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            gap: "12px", flexWrap: "wrap" as const, marginTop: "4px",
          }}>
            <button
              id="btn-download-production-pdf"
              type="button"
              onClick={handleDownloadPdf}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                gap: "8px", borderRadius: "9999px",
                padding: "12px 38px", fontSize: "13.5px", fontWeight: 700,
                color: "#1a150b", border: "none", cursor: "pointer",
                background: "linear-gradient(135deg, #f1cd7b 0%, #e5ba6b 50%, #c5942a 100%)",
                boxShadow: "0 4px 22px rgba(216,168,78,0.45)",
                transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
              }}
              className="hover:shadow-[0_6px_30px_rgba(216,168,78,0.65)]! hover:scale-[1.02]! active:scale-[0.98]!"
            >
              <Download size={15} />
              <span>Download Production PDF</span>
            </button>

            {pdfUrl && (
              <a href={pdfUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <button
                  type="button"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "7px",
                    borderRadius: "9999px", padding: "12px 22px", fontSize: "13px",
                    fontWeight: 600, color: "#cbd5e1", cursor: "pointer",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.09)",
                    transition: "all 0.15s",
                  }}
                  className="hover:border-[rgba(255,255,255,0.22)]! hover:text-white! hover:bg-[rgba(255,255,255,0.06)]! active:scale-98!"
                >
                  <ExternalLink size={14} />
                  <span>Open in New Tab</span>
                </button>
              </a>
            )}

            <button
              type="button"
              onClick={handleReset}
              style={{
                display: "inline-flex", alignItems: "center", gap: "7px",
                borderRadius: "9999px", padding: "12px 22px", fontSize: "13px",
                fontWeight: 600, color: "#94a3b8", cursor: "pointer",
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.09)",
                transition: "all 0.15s",
              }}
              className="hover:border-[rgba(255,255,255,0.18)]! hover:text-[#e2e8f0]! hover:bg-[rgba(255,255,255,0.03)]! active:scale-98!"
            >
              <RotateCcw size={14} />
              <span>New Order</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
