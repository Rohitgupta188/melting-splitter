"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DropdownOption {
  value: string;
  label: string;
  dotColor?: string;
}

interface ModernDropdownProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  className?: string;
  height?: string | number;
}

export function ModernDropdown({
  id,
  value,
  onChange,
  options,
  placeholder = "Select…",
  className,
  height = "38px",
}: ModernDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((opt) => opt.value === value);

  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [isOpen, close]);

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }} className={className}>
      {/* Trigger */}
      <button
        id={id}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: "flex",
          height: typeof height === "number" ? `${height}px` : height,
          width: "100%",
          alignItems: "center",
          justifyContent: "space-between",
          borderRadius: "10px",
          border: isOpen ? "1px solid rgba(216,168,78,0.4)" : "1px solid rgba(255,255,255,0.10)",
          background: "#080d16",
          padding: "0 14px",
          fontSize: "13px",
          color: "#fff",
          cursor: "pointer",
          transition: "border-color 0.2s, box-shadow 0.2s",
          boxShadow: isOpen ? "0 0 0 3px rgba(216,168,78,0.08)" : "none",
          outline: "none",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
          {selectedOption?.dotColor && (
            <span style={{
              width: "10px", height: "10px", borderRadius: "50%", flexShrink: 0,
              backgroundColor: selectedOption.dotColor,
              boxShadow: `0 0 6px ${selectedOption.dotColor}40`,
            }} />
          )}
          <span style={{ fontWeight: 500, color: "#e2e8f0" }}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
        </span>
        <ChevronDown
          size={14}
          style={{
            color: isOpen ? "#d8a84e" : "#64748b",
            transition: "transform 0.2s, color 0.2s",
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
            flexShrink: 0,
            marginLeft: "8px",
          }}
        />
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div style={{
          position: "absolute",
          zIndex: 50,
          marginTop: "6px",
          width: "100%",
          borderRadius: "12px",
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(12,17,32,0.98)",
          padding: "4px",
          boxShadow: "0 20px 48px rgba(0,0,0,0.7)",
          backdropFilter: "blur(20px)",
        }}>
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); setIsOpen(false); }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  fontSize: "13px",
                  borderRadius: "8px",
                  cursor: "pointer",
                  transition: "background 0.15s",
                  border: "none",
                  background: isSelected ? "rgba(216,168,78,0.1)" : "transparent",
                  color: isSelected ? "#f1cd7b" : "#cbd5e1",
                  fontWeight: isSelected ? 600 : 400,
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isSelected ? "rgba(216,168,78,0.1)" : "transparent";
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  {opt.dotColor && (
                    <span style={{
                      width: "10px", height: "10px", borderRadius: "50%", flexShrink: 0,
                      backgroundColor: opt.dotColor,
                    }} />
                  )}
                  <span>{opt.label}</span>
                </span>
                {isSelected && <Check size={13} color="#d8a84e" style={{ flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
