"use client";

import React, { useState, useCallback } from "react";
import {
  Upload,
  FileDown,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  FileText,
  Layers,
  ImageIcon,
  Zap,
  Archive,
  Loader2,
  FolderTree,
  Flame,
  Files,
  Circle,
  CheckCircle2,
  Sparkles,
  ClipboardList,
  Printer,
} from "lucide-react";
import JSZip from "jszip";
import { saveAs } from "file-saver";

import { parsePDF } from "@/lib/pdf-parser";
import { groupRows, GroupedData, SplitMode } from "@/lib/grouping";
import {
  resolveImages,
  getImageStats,
  resetImageState,
  ImageStats,
  getCachedImage,
} from "@/lib/image-service";
import { generateGroupPdfBlob } from "@/lib/generateSplitPdf";
import { buildProductionPDF, PdfQuotationLineItem } from "@/lib/production";
import { ParsedRow, QuotationHeader } from "@/lib/types";
import { ManualOrderPlace } from "@/components/ManualOrderPlace";

import logoImg from "./icon.png";

// Helper to load local logo as base64
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


// ─── Types ───────────────────────────────────────────────────────────────────

type Stage =
  | "IDLE"
  | "READING_PDF"
  | "PARSING_ROWS"
  | "REVIEW_GROUPS"
  | "FETCHING_IMAGES"
  | "GENERATING_PDFS"
  | "CREATING_ZIP"
  | "COMPLETED"
  | "ERROR";

interface ProcessLog {
  totalRows: number;
  groups: GroupedData[];
  imageStats: ImageStats;
  pdfsGenerated: number;
  elapsedSeconds: number;
}

// ─── Stage step config ───────────────────────────────────────────────────────

const PIPELINE_STEPS: { stage: Stage; label: string; icon: React.ElementType }[] = [
  { stage: "READING_PDF",    label: "Reading PDF",      icon: FileText    },
  { stage: "PARSING_ROWS",   label: "Parsing rows",     icon: Layers      },
  { stage: "FETCHING_IMAGES",label: "Fetching images",  icon: ImageIcon   },
  { stage: "GENERATING_PDFS",label: "Generating PDFs",  icon: Zap         },
  { stage: "CREATING_ZIP",   label: "Creating ZIP",     icon: Archive     },
  { stage: "COMPLETED",      label: "Complete",         icon: CheckCircle },
];

const ACTIVE_STAGES = new Set<Stage>([
  "READING_PDF", "PARSING_ROWS", "FETCHING_IMAGES", "GENERATING_PDFS", "CREATING_ZIP",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const YIELD_EVERY = 3;

/**
 * Production-grade utility to yield to the main thread.
 * It uses the modern `scheduler.yield()` API if available, which prioritizes continuations.
 * Otherwise, it falls back to a macrotask via setTimeout(0) when scheduler.yield() isn't available.
 */
async function yieldToMain(): Promise<void> {
  if (typeof globalThis.scheduler !== "undefined" && typeof globalThis.scheduler.yield === "function") {
    return globalThis.scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stageIndex(stage: Stage): number {
  if (stage === "REVIEW_GROUPS") {
    // Pause the timeline on "FETCHING_IMAGES" so previous steps remain highlighted as "done"
    return PIPELINE_STEPS.findIndex(s => s.stage === "FETCHING_IMAGES");
  }
  return PIPELINE_STEPS.findIndex(s => s.stage === stage);
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Home() {
  const [activeTab,     setActiveTab]     = useState<"SPLITTER" | "MANUAL_ORDER">("SPLITTER");
  const [dragActive,    setDragActive]    = useState(false);
  const [stage,         setStage]         = useState<Stage>("IDLE");
  const [errorMsg,      setErrorMsg]      = useState<string | null>(null);
  const [selectedFile,  setSelectedFile]  = useState<File | null>(null);
  const [stageDetail,   setStageDetail]   = useState<string>("");
  const [splitMode,     setSplitMode]     = useState<SplitMode>("category");
  const [outputMode,    setOutputMode]    = useState<"individual" | "combined">("individual");
  const [layoutMode,    setLayoutMode]    = useState<"standard" | "production">("standard");

  // Intermediate state
  const [rawRows,        setRawRows]        = useState<ParsedRow[]>([]);
  const [groups,         setGroups]         = useState<GroupedData[]>([]);
  const [quotationHeader,setQuotationHeader]= useState<QuotationHeader>({});
  const [processLog,     setProcessLog]     = useState<ProcessLog | null>(null);
  const [zipBlob,        setZipBlob]        = useState<Blob | null>(null);

  const isProcessing = ACTIVE_STAGES.has(stage) || stage === "REVIEW_GROUPS";

  // Removed problematic useEffect for splitMode
  // ── Validation ─────────────────────────────────────────────────────────────

  function validateFile(file: File): string | null {
    if (file.type !== "application/pdf") {
      return `Invalid file type "${file.type || "unknown"}". Please upload a PDF.`;
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File exceeds the 100 MB limit (${(file.size / 1024 / 1024).toFixed(1)} MB).`;
    }
    return null;
  }

  // ── Phase 1: Parse PDF ─────────────────────────────────────────────────────

  const handleParseFile = useCallback(async (file: File) => {
    const validationError = validateFile(file);
    if (validationError) {
      setErrorMsg(validationError);
      setStage("ERROR");
      return;
    }

    setSelectedFile(file);
    setErrorMsg(null);
    setZipBlob(null);
    setProcessLog(null);
    resetImageState();

    try {
      setStage("READING_PDF");
      setStageDetail("");
      await new Promise(r => setTimeout(r, 50)); // allow re-render

      setStage("PARSING_ROWS");
      const { header, rows, pdfDoc, loadingTask } = await parsePDF(file);

      if (rows.length === 0) {
        throw new Error("No valid product rows found in the PDF.");
      }

      setStage("FETCHING_IMAGES");
      setStageDetail(`Looking up ${[...new Set(rows.map(r => r.rawDesignNumber))].length} unique products from database…`);
      try {
        await resolveImages(rows, pdfDoc);
      } finally {
        // destroy() lives on the PDFDocumentLoadingTask, not the PDFDocumentProxy.
        // This terminates the PDF.js worker and frees all associated memory.
        await loadingTask.destroy();
      }

      const grouped = groupRows(rows, splitMode);
      setRawRows(rows);
      setGroups(grouped);
      setQuotationHeader(header);
      
      setStageDetail(`Resolved ${rows.length} images. Found ${rows.length} items across ${grouped.length} categories.`);
      setStage("REVIEW_GROUPS");
    } catch (err: any) {
      console.error("[page] parse error:", err);
      setErrorMsg(err?.message ?? "Processing failed. Please try again.");
      setStage("ERROR");
    }
  }, [splitMode]);

  // ── Phase 2: Generate PDFs ─────────────────────────────────────────────────

  const handleGeneratePdfs = useCallback(async () => {
    const startTime = performance.now();

    try {
      const imgStats = getImageStats();

      // Generate PDFs
      setStage("GENERATING_PDFS");
      // Only process groups that were selected by the user
      const finalGroups = groups.filter(g => g.selected !== false);

      let processGroups = finalGroups;
      
      const logoBase64 = layoutMode === "production" ? await getLogoBase64() : null;

      
      if (outputMode === "combined" && finalGroups.length > 0) {
        const combinedName = finalGroups.map(g => g.groupName).join(", ");
        const shortName = combinedName.length > 40 ? "Combined Items" : combinedName;
        
        const combinedGroup: GroupedData = {
          groupName: shortName,
          items: finalGroups.flatMap(g => g.items).sort((a, b) => 
            a.rawDesignNumber.localeCompare(b.rawDesignNumber, undefined, { numeric: true, sensitivity: 'base' })
          ),
          totalQty: finalGroups.reduce((acc, g) => acc + g.totalQty, 0),
          totalGrossWt: finalGroups.reduce((acc, g) => acc + g.totalGrossWt, 0),
          totalNetWt: finalGroups.reduce((acc, g) => acc + g.totalNetWt, 0),
          totalStoneWt: finalGroups.reduce((acc, g) => acc + g.totalStoneWt, 0),
          selected: true
        };
        processGroups = [combinedGroup];
      }

      const zip = new JSZip();
      
      const cleanName = (str: string) => str.replace(/[\\/:*?"<>|]/g, "").trim();
      const custName = cleanName(quotationHeader.customerName || "Customer");
      const qNo = cleanName(quotationHeader.quotationNo || "Quotation");
      const suffix = `${custName} ${qNo}`.trim();

      for (let i = 0; i < processGroups.length; i++) {
        const g = processGroups[i];
        setStageDetail(`Generating PDF ${i + 1} of ${processGroups.length}: ${g.groupName}`);
        
        // Yield to the main thread in batches to allow the UI to update and spinner to animate
        // We yield periodically instead of after every single PDF to avoid excessive overhead
        if ((i + 1) % YIELD_EVERY === 0) {
          await yieldToMain();
        }
        
        let pdfBlob: Blob;
        if (layoutMode === "production") {
          const lineItems: PdfQuotationLineItem[] = g.items.map(item => ({
            sku: item.designNumber, // Use design number as SKU
            designNumber: item.designNumber,
            itemType: item.itemType,
            grossWeight: item.grossWeight,
            netWeight: item.netWeight,
            stoneWeight: item.stoneWeight,
            reserved1: item.reserved1,
            reserved3: item.reserved3,
            metalPurity: item.kt,
            metalType: item.color,
            imageUrl: getCachedImage(item.imageUrl) || item.imageUrl,
            qty: item.qty,
            remarks: item.remarks
          }));

          pdfBlob = await buildProductionPDF({
            quotationNo: quotationHeader.quotationNo || "Quotation",
            companyName: quotationHeader.customerName || "Customer",
            contactName: quotationHeader.contactName || "",
            address: quotationHeader.customerAddress || "",
            remarks: quotationHeader.remarks || "",
            date: quotationHeader.date || new Date().toLocaleDateString(),
            lineItems,
            logoBase64,
          });
        } else {
          pdfBlob = await generateGroupPdfBlob(g, quotationHeader);
        }

        const groupNameClean = cleanName(g.groupName);
        zip.file(`${groupNameClean} - ${suffix}.pdf`, pdfBlob);
      }

      // ZIP
      setStage("CREATING_ZIP");
      setStageDetail("Compressing…");
      const content = await zip.generateAsync({ type: "blob" });

      const elapsed = (performance.now() - startTime) / 1000;

      setZipBlob(content);
      setProcessLog({
        totalRows:      rawRows.length,
        groups:         finalGroups,
        imageStats:     imgStats,
        pdfsGenerated:  processGroups.length,
        elapsedSeconds: elapsed,
      });
      setStage("COMPLETED");
    } catch (err: any) {
      console.error("[page] generate error:", err);
      setErrorMsg(err?.message ?? "Processing failed. Please try again.");
      setStage("ERROR");
    }
  }, [rawRows, quotationHeader, groups, outputMode, layoutMode]);

  // ── Event handlers ─────────────────────────────────────────────────────────

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      if (isProcessing) return;
      const file = e.dataTransfer.files?.[0];
      if (file) await handleParseFile(file);
    },
    [isProcessing, handleParseFile]
  );

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (isProcessing) return;
      const file = e.target.files?.[0];
      if (file) await handleParseFile(file);
      e.target.value = ""; // allow re-selecting same file
    },
    [isProcessing, handleParseFile]
  );

  const handleDownload = () => {
    if (zipBlob) {
      const cleanName = (str: string) => str.replace(/[\\/:*?"<>|]/g, "").trim();
      const custName = cleanName(quotationHeader.customerName || "Customer");
      const qNo = cleanName(quotationHeader.quotationNo || "Quotation");
      saveAs(zipBlob, `${custName} ${qNo}.zip`);
    }
  };

  const handleReset = () => {
    setStage("IDLE");
    setErrorMsg(null);
    setZipBlob(null);
    setGroups([]);
    setRawRows([]);
    setProcessLog(null);
    setSelectedFile(null);
    setStageDetail("");
    setQuotationHeader({});
    resetImageState();
  };

  const handleRetry = () => {
    if (selectedFile) {
      handleParseFile(selectedFile);
    } else {
      handleReset();
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const showDropzone = stage === "IDLE" || stage === "ERROR";

  const currentStepIdx = stageIndex(stage);

  return (
    <div className={`ms-root ${activeTab === "MANUAL_ORDER" ? "ms-root--manual-order" : ""}`}>
      {/* ── Background orbs ── */}

      <div className={`ms-container ${activeTab === "MANUAL_ORDER" ? "ms-container--manual-order" : stage === "REVIEW_GROUPS" ? "ms-container--wide" : ""}`}>

        {/* ── Header ── */}
        <header className="text-center mb-2">
          {activeTab === "MANUAL_ORDER" ? (
            <div className="flex flex-col items-center">
              <h1 className="font-serif text-2xl sm:text-3xl text-[#d4af37] font-normal tracking-tight mb-1">
                Create Manual Order
              </h1>
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <h1 className="font-serif text-2xl sm:text-3xl text-[#d4af37] font-normal tracking-tight mb-1">
                Melting Splitter
              </h1>
            </div>
          )}
        </header>

        {/* ── Navigation Tabs ── */}
        <nav className="ms-nav-tabs mb-4" aria-label="Feature navigation">
          <button
            type="button"
            id="tab-splitter"
            onClick={() => setActiveTab("SPLITTER")}
            className={`ms-nav-tab ${activeTab === "SPLITTER" ? "ms-nav-tab--active" : ""}`}
          >
            <FileText size={16} />
            <span>Split Quotation PDF</span>
          </button>
          <button
            type="button"
            id="tab-manual-order"
            onClick={() => setActiveTab("MANUAL_ORDER")}
            className={`ms-nav-tab ${activeTab === "MANUAL_ORDER" ? "ms-nav-tab--active" : ""}`}
          >
            <Printer size={16} />
            <span>Manual Order Place</span>
          </button>
        </nav>

        {/* ── Main Feature Content ── */}
        {activeTab === "MANUAL_ORDER" ? (
          <ManualOrderPlace />
        ) : (
          <>
            {/* ── Upload Zone ── */}
            {showDropzone && (
          <div
            id="dropzone"
            className={`ms-dropzone ${dragActive ? "ms-dropzone--active" : ""} ${
              isProcessing ? "ms-dropzone--disabled" : ""
            }`}
            onDragOver={e => { e.preventDefault(); if (!isProcessing) setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            role="region"
            aria-label="PDF upload area"
            style={{
              border: "1.5px dashed rgba(216, 168, 78, 0.35)",
              borderRadius: "16px",
              padding: "1.75rem 2rem",
              textAlign: "center",
              cursor: "pointer",
              transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
              background: "rgba(14, 20, 34, 0.88)",
              backdropFilter: "blur(20px)",
              boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.45rem",
            }}
          >
            <div style={{
              width: 42, height: 42, borderRadius: "10px",
              background: "rgba(216,168,78,0.12)",
              border: "1px solid rgba(216,168,78,0.25)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 0 18px rgba(216,168,78,0.18)",
              marginBottom: "2px",
            }}>
              <Upload size={18} color="#f1cd7b" />
            </div>
            <p style={{ fontSize: "14px", fontWeight: 600, color: "#fff", margin: 0 }}>
              {selectedFile && stage === "ERROR"
                ? selectedFile.name
                : "Drag & drop your jewellery quotation PDF here"}
            </p>
            <p style={{ fontSize: "12px", color: "#64748b", margin: 0 }}>or</p>
            <label
              style={{
                display: "inline-flex", alignItems: "center", gap: "8px",
                borderRadius: "9999px", padding: "9px 26px", fontSize: "13px", fontWeight: 700,
                color: "#1a150b", border: "none", cursor: isProcessing ? "not-allowed" : "pointer",
                background: "linear-gradient(135deg, #f1cd7b 0%, #e5ba6b 50%, #c5942a 100%)",
                boxShadow: "0 4px 18px rgba(216,168,78,0.4)",
                transition: "transform 0.15s, box-shadow 0.15s",
              }}
              className="hover:scale-[1.02]! active:scale-[0.98]!"
              htmlFor="pdf-input"
            >
              Choose PDF File
              <input
                id="pdf-input"
                type="file"
                accept="application/pdf"
                className="sr-only"
                onChange={handleFileInput}
                disabled={isProcessing}
              />
            </label>
            <p style={{ fontSize: "11px", color: "#64748b", margin: "2px 0 0" }}>PDF only · Max 100 MB</p>
          </div>
        )}

        {/* ── Pipeline progress ── */}
        {stage !== "IDLE" && stage !== "ERROR" && (
          <div className="ms-card">

            {/* Progress steps */}
            <div className="ms-steps">
              {PIPELINE_STEPS.map((step, idx) => {
                const done    = idx < currentStepIdx;
                const active  = idx === currentStepIdx;
                const pending = idx > currentStepIdx;
                const Icon    = step.icon;
                return (
                  <div
                    key={step.stage}
                    className={`ms-step ${done ? "ms-step--done" : ""} ${active ? "ms-step--active" : ""} ${pending ? "ms-step--pending" : ""}`}
                  >
                    <div className="ms-step-icon">
                      {done ? (
                        <CheckCircle size={14} />
                      ) : active && stage !== "REVIEW_GROUPS" && stage !== "COMPLETED" ? (
                        <Loader2 size={14} className="ms-spin" />
                      ) : (
                        <Icon size={14} />
                      )}
                    </div>
                    <span className="ms-step-label">{step.label}</span>
                  </div>
                );
              })}
            </div>

            {/* Stage detail / context */}
            {stageDetail && stage !== "REVIEW_GROUPS" && stage !== "COMPLETED" && (
              <p className="ms-stage-detail">{stageDetail}</p>
            )}

            {/* ── REVIEW_GROUPS ── */}
            {stage === "REVIEW_GROUPS" && (
              <div className="ms-review" style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "2px" }}>
                <p style={{ fontSize: "12px", color: "#94a3b8", textAlign: "center", margin: 0 }}>
                  {stageDetail}
                </p>

                {/* Controls Bar */}
                <div style={{
                  display: "flex", justifyContent: "center", alignItems: "center",
                  gap: "10px", flexWrap: "wrap", margin: "2px 0",
                }}>
                  {/* Category / Melting toggle */}
                  <div style={{
                    display: "flex", background: "rgba(10, 15, 26, 0.8)",
                    padding: "3px", borderRadius: "9999px",
                    border: "1px solid rgba(255,255,255,0.08)", gap: "3px",
                  }}>
                    <button
                      type="button"
                      onClick={() => {
                        setSplitMode("category");
                        if (stage === "REVIEW_GROUPS" && rawRows.length > 0) {
                          setGroups(groupRows(rawRows, "category"));
                        }
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: "6px",
                        padding: "5px 14px", borderRadius: "9999px", border: "none",
                        cursor: "pointer", fontSize: "12px",
                        fontWeight: splitMode === "category" ? 700 : 500,
                        background: splitMode === "category" ? "linear-gradient(135deg, #f1cd7b, #c5942a)" : "transparent",
                        color: splitMode === "category" ? "#1a150b" : "#94a3b8",
                        transition: "all 0.15s",
                      }}
                    >
                      <FolderTree size={13} /> Category
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSplitMode("melting");
                        if (stage === "REVIEW_GROUPS" && rawRows.length > 0) {
                          setGroups(groupRows(rawRows, "melting"));
                        }
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: "6px",
                        padding: "5px 14px", borderRadius: "9999px", border: "none",
                        cursor: "pointer", fontSize: "12px",
                        fontWeight: splitMode === "melting" ? 700 : 500,
                        background: splitMode === "melting" ? "linear-gradient(135deg, #f1cd7b, #c5942a)" : "transparent",
                        color: splitMode === "melting" ? "#1a150b" : "#94a3b8",
                        transition: "all 0.15s",
                      }}
                    >
                      <Flame size={13} /> Melting
                    </button>
                  </div>

                  {/* Individual / Combined toggle */}
                  <div style={{
                    display: "flex", background: "rgba(10, 15, 26, 0.8)",
                    padding: "3px", borderRadius: "9999px",
                    border: "1px solid rgba(255,255,255,0.08)", gap: "3px",
                  }}>
                    <button
                      type="button"
                      onClick={() => setOutputMode("individual")}
                      style={{
                        display: "flex", alignItems: "center", gap: "6px",
                        padding: "5px 14px", borderRadius: "9999px", border: "none",
                        cursor: "pointer", fontSize: "12px",
                        fontWeight: outputMode === "individual" ? 700 : 500,
                        background: outputMode === "individual" ? "linear-gradient(135deg, #f1cd7b, #c5942a)" : "transparent",
                        color: outputMode === "individual" ? "#1a150b" : "#94a3b8",
                        transition: "all 0.15s",
                      }}
                    >
                      <FileText size={13} /> Individual
                    </button>
                    <button
                      type="button"
                      onClick={() => setOutputMode("combined")}
                      style={{
                        display: "flex", alignItems: "center", gap: "6px",
                        padding: "5px 14px", borderRadius: "9999px", border: "none",
                        cursor: "pointer", fontSize: "12px",
                        fontWeight: outputMode === "combined" ? 700 : 500,
                        background: outputMode === "combined" ? "linear-gradient(135deg, #f1cd7b, #c5942a)" : "transparent",
                        color: outputMode === "combined" ? "#1a150b" : "#94a3b8",
                        transition: "all 0.15s",
                      }}
                    >
                      <Files size={13} /> Combined
                    </button>
                  </div>

                  {/* Layout mode toggle */}
                  <div style={{
                    display: "flex", background: "rgba(10, 15, 26, 0.8)",
                    padding: "3px", borderRadius: "9999px",
                    border: "1px solid rgba(255,255,255,0.08)", gap: "3px",
                  }}>
                    <button
                      type="button"
                      onClick={() => setLayoutMode("standard")}
                      style={{
                        display: "flex", alignItems: "center", gap: "6px",
                        padding: "5px 14px", borderRadius: "9999px", border: "none",
                        cursor: "pointer", fontSize: "12px",
                        fontWeight: layoutMode === "standard" ? 700 : 500,
                        background: layoutMode === "standard" ? "linear-gradient(135deg, #f1cd7b, #c5942a)" : "transparent",
                        color: layoutMode === "standard" ? "#1a150b" : "#94a3b8",
                        transition: "all 0.15s",
                      }}
                    >
                      <Layers size={13} /> Standard
                    </button>
                    <button
                      type="button"
                      onClick={() => setLayoutMode("production")}
                      style={{
                        display: "flex", alignItems: "center", gap: "6px",
                        padding: "5px 14px", borderRadius: "9999px", border: "none",
                        cursor: "pointer", fontSize: "12px",
                        fontWeight: layoutMode === "production" ? 700 : 500,
                        background: layoutMode === "production" ? "linear-gradient(135deg, #f1cd7b, #c5942a)" : "transparent",
                        color: layoutMode === "production" ? "#1a150b" : "#94a3b8",
                        transition: "all 0.15s",
                      }}
                    >
                      <Zap size={13} /> Production
                    </button>
                  </div>
                </div>

                {/* Table Header */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "2px 2px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 700, color: "#fff", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {splitMode === "category" ? "Categories" : "Melting Groups"} ({groups.filter(g => g.selected !== false).length}/{groups.length})
                  </span>
                  <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <button
                      type="button"
                      onClick={() => setGroups(groups.map(g => ({ ...g, selected: true })))}
                      style={{ background: "none", border: "none", color: "#f1cd7b", cursor: "pointer", fontSize: "11px", fontWeight: 600, padding: 0 }}
                    >
                      Select All
                    </button>
                    <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "10px" }}>•</span>
                    <button
                      type="button"
                      onClick={() => setGroups(groups.map(g => ({ ...g, selected: false })))}
                      style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "11px", padding: 0 }}
                    >
                      Clear All
                    </button>
                  </div>
                </div>

                {/* Table Container with Internal Scroll */}
                <div style={{
                  maxHeight: "175px", overflowY: "auto",
                  border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px",
                  background: "#070b13",
                }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "12px" }}>
                    <thead style={{ position: "sticky", top: 0, background: "#0b101c", zIndex: 2 }}>
                      <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#94a3b8" }}>
                        <th style={{ padding: "7px 12px", width: "36px", textAlign: "center" }}></th>
                        <th style={{ padding: "7px 10px", width: "36px" }}>Sr.</th>
                        <th style={{ padding: "7px 12px" }}>{splitMode === "category" ? "Item Type" : "Melting"}</th>
                        <th style={{ padding: "7px 12px", textAlign: "center" }}>Qty</th>
                        <th style={{ padding: "7px 14px", textAlign: "right" }}>Gross Wt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g, i) => {
                        const isSelected = g.selected !== false;
                        return (
                          <tr
                            key={g.groupName}
                            onClick={() => {
                              const newGroups = [...groups];
                              newGroups[i].selected = !isSelected;
                              setGroups(newGroups);
                            }}
                            style={{
                              cursor: "pointer",
                              borderBottom: i === groups.length - 1 ? "none" : "1px solid rgba(255,255,255,0.04)",
                              background: isSelected ? "rgba(216,168,78,0.08)" : "transparent",
                              transition: "background 0.15s",
                            }}
                            className="hover:bg-[rgba(255,255,255,0.03)]!"
                          >
                            <td style={{ padding: "5px 12px", textAlign: "center", color: isSelected ? "#f1cd7b" : "#64748b" }}>
                              {isSelected ? <CheckCircle2 size={14} color="#f1cd7b" /> : <Circle size={14} color="#64748b" />}
                            </td>
                            <td style={{ padding: "5px 10px", color: "#64748b", fontSize: "11px" }}>{i + 1}</td>
                            <td style={{ padding: "5px 12px", fontWeight: 500, color: "#f1f5f9" }}>{g.groupName}</td>
                            <td style={{ padding: "5px 12px", textAlign: "center", color: "#cbd5e1" }}>{g.totalQty}</td>
                            <td style={{ padding: "5px 14px", textAlign: "right", color: "#f1cd7b", fontWeight: 600 }}>{g.totalGrossWt.toFixed(3)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot style={{ position: "sticky", bottom: 0, background: "#0b101c", borderTop: "1px solid rgba(255,255,255,0.1)", fontWeight: 700, fontSize: "12px" }}>
                      <tr>
                        <td colSpan={3} style={{ padding: "7px 12px", textAlign: "right", color: "#94a3b8" }}>Selected Total:</td>
                        <td style={{ padding: "7px 12px", textAlign: "center", color: "#fff" }}>
                          {groups.reduce((acc, g) => acc + (g.selected !== false ? g.totalQty : 0), 0)}
                        </td>
                        <td style={{ padding: "7px 14px", textAlign: "right", color: "#f1cd7b" }}>
                          {groups.reduce((acc, g) => acc + (g.selected !== false ? g.totalGrossWt : 0), 0).toFixed(3)} g
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Actions */}
                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "12px", marginTop: "6px" }}>
                  <button
                    id="btn-generate"
                    type="button"
                    onClick={handleGeneratePdfs}
                    style={{
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      gap: "8px", borderRadius: "9999px",
                      padding: "11px 40px", fontSize: "13.5px", fontWeight: 700,
                      color: "#1a150b", border: "none", cursor: "pointer",
                      background: "linear-gradient(135deg, #f1cd7b 0%, #e5ba6b 50%, #c5942a 100%)",
                      boxShadow: "0 4px 20px rgba(216,168,78,0.45)",
                      transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
                    }}
                    className="hover:shadow-[0_6px_30px_rgba(216,168,78,0.65)]! hover:scale-[1.02]! active:scale-[0.98]!"
                  >
                    <Zap size={15} />
                    <span>Generate PDFs</span>
                  </button>
                  <button
                    id="btn-cancel"
                    type="button"
                    onClick={handleReset}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "6px",
                      borderRadius: "9999px", padding: "11px 22px", fontSize: "13px",
                      fontWeight: 600, color: "#94a3b8", cursor: "pointer",
                      background: "transparent",
                      border: "1px solid rgba(255,255,255,0.09)",
                      transition: "all 0.15s",
                    }}
                    className="hover:border-[rgba(255,255,255,0.18)]! hover:text-white! hover:bg-[rgba(255,255,255,0.03)]!"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* ── COMPLETED ── */}
            {stage === "COMPLETED" && processLog && (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%", marginTop: "2px" }}>
                {/* Hero Banner */}
                <div style={{
                  background: "rgba(14, 20, 34, 0.88)",
                  backdropFilter: "blur(20px)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: "14px",
                  padding: "14px 20px",
                  position: "relative",
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "10px",
                }}>
                  <div style={{
                    position: "absolute", top: 0, left: 0, right: 0, height: "1px",
                    background: "linear-gradient(90deg, transparent, rgba(216,168,78,0.6), transparent)",
                  }} />
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div style={{
                      width: 40, height: 40, borderRadius: "10px", flexShrink: 0,
                      background: "rgba(216,168,78,0.12)",
                      border: "1.5px solid rgba(216,168,78,0.28)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      boxShadow: "0 0 18px rgba(216,168,78,0.2)",
                    }}>
                      <CheckCircle2 size={18} color="#f1cd7b" />
                    </div>
                    <div>
                      <h2 style={{ fontSize: "15px", fontWeight: 700, color: "#fff", margin: "0 0 2px" }}>
                        Quotation PDFs Ready!
                      </h2>
                      <p style={{ fontSize: "12px", color: "#94a3b8", margin: 0 }}>
                        Completed in <span style={{ color: "#f1cd7b", fontWeight: 600 }}>{processLog.elapsedSeconds.toFixed(1)}s</span> with {processLog.pdfsGenerated} PDF{processLog.pdfsGenerated !== 1 ? "s" : ""} generated
                      </p>
                    </div>
                  </div>

                  <div style={{
                    display: "inline-flex", alignItems: "center", gap: "5px",
                    padding: "4px 10px", borderRadius: "9999px",
                    background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.25)",
                    color: "#34d399", fontSize: "11px", fontWeight: 600,
                  }}>
                    <CheckCircle size={11} />
                    <span>ZIP Archive Ready</span>
                  </div>
                </div>

                {/* 4 Stats Cards */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px" }}>
                  {[
                    { label: "Rows Parsed", value: String(processLog.totalRows), gold: false },
                    { label: "Groups", value: String(processLog.groups.length), gold: false },
                    { label: "Images", value: String(processLog.imageStats.catalogue + processLog.imageStats.native + processLog.imageStats.crop), gold: false },
                    { label: "PDFs Generated", value: String(processLog.pdfsGenerated), gold: true },
                  ].map((s) => (
                    <div key={s.label} style={{
                      background: "rgba(14, 20, 34, 0.88)",
                      border: s.gold ? "1px solid rgba(216,168,78,0.25)" : "1px solid rgba(255,255,255,0.08)",
                      borderRadius: "12px",
                      padding: "10px 12px",
                      textAlign: "center",
                    }}>
                      <p style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#64748b", margin: "0 0 3px" }}>
                        {s.label}
                      </p>
                      <p style={{ fontSize: "18px", fontWeight: 700, margin: 0, color: s.gold ? "#f1cd7b" : "#fff" }}>
                        {s.value}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Action Buttons */}
                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "10px", marginTop: "4px", flexWrap: "wrap" }}>
                  <button
                    id="btn-download"
                    type="button"
                    onClick={handleDownload}
                    style={{
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      gap: "8px", borderRadius: "9999px",
                      padding: "11px 36px", fontSize: "13.5px", fontWeight: 700,
                      color: "#1a150b", border: "none", cursor: "pointer",
                      background: "linear-gradient(135deg, #f1cd7b 0%, #e5ba6b 50%, #c5942a 100%)",
                      boxShadow: "0 4px 20px rgba(216,168,78,0.45)",
                      transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
                    }}
                    className="hover:shadow-[0_6px_28px_rgba(216,168,78,0.65)]! hover:scale-[1.02]! active:scale-[0.98]!"
                  >
                    <FileDown size={15} />
                    <span>Download ZIP</span>
                  </button>

                  <button
                    id="btn-back-options"
                    type="button"
                    onClick={() => {
                      setStage("REVIEW_GROUPS");
                      setZipBlob(null);
                      setProcessLog(null);
                    }}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "6px",
                      borderRadius: "9999px", padding: "11px 20px", fontSize: "12.5px",
                      fontWeight: 600, color: "#cbd5e1", cursor: "pointer",
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.09)",
                      transition: "all 0.15s",
                    }}
                    className="hover:border-[rgba(255,255,255,0.2)]! hover:text-white! hover:bg-[rgba(255,255,255,0.05)]!"
                  >
                    <Layers size={13} />
                    <span>Change Options</span>
                  </button>

                  <button
                    id="btn-start-over"
                    type="button"
                    onClick={handleReset}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "6px",
                      borderRadius: "9999px", padding: "11px 20px", fontSize: "12.5px",
                      fontWeight: 600, color: "#94a3b8", cursor: "pointer",
                      background: "transparent",
                      border: "1px solid rgba(255,255,255,0.09)",
                      transition: "all 0.15s",
                    }}
                    className="hover:border-[rgba(255,255,255,0.18)]! hover:text-[#e2e8f0]! hover:bg-[rgba(255,255,255,0.03)]!"
                  >
                    <RefreshCw size={13} />
                    <span>Upload New PDF</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Error card ── */}
        {stage === "ERROR" && (
          <div className="ms-card ms-card--error" role="alert">
            <AlertCircle className="ms-error-icon" />
            <h3 className="ms-error-title">Processing Failed</h3>
            <p className="ms-error-msg">{errorMsg}</p>
            <div className="ms-error-actions">
              {selectedFile && (
                <button
                  id="btn-retry"
                  className="ms-btn ms-btn--primary"
                  onClick={handleRetry}
                >
                  <RefreshCw size={16} /> Retry
                </button>
              )}
              <button
                id="btn-try-again"
                className="ms-btn ms-btn--ghost"
                onClick={handleReset}
              >
                Choose different file
              </button>
            </div>
          </div>
        )}
          </>
        )}

      </div>
    </div>
  );
}



