import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const DEFAULT_ROLE = "elektriker";
const DEFAULT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 365; // 1 year
const MAX_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 365;

type CandidateRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  primary_role?: string | null;
  status?: string | null;
  created_at?: string | null;
  cv_key: string | null;
};

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/["\n\r,]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseExpiresInSeconds(searchParams: URLSearchParams): number {
  const secondsParam = searchParams.get("expiresInSeconds");
  if (secondsParam) {
    const parsed = Number.parseInt(secondsParam, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_EXPIRES_IN_SECONDS);
    }
  }

  const daysParam = searchParams.get("expiresInDays");
  if (daysParam) {
    const parsed = Number.parseInt(daysParam, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed * 24 * 60 * 60, MAX_EXPIRES_IN_SECONDS);
    }
  }

  return DEFAULT_EXPIRES_IN_SECONDS;
}

function isAuthorized(secret: string | null): boolean {
  if (process.env.NODE_ENV === "development") {
    return true;
  }

  const exportSecret = process.env.CAMPAIGN_EXPORT_SECRET;
  if (!exportSecret) {
    return false;
  }

  return secret === exportSecret;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");

  if (!isAuthorized(secret)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const role = (searchParams.get("role") || searchParams.get("position") || DEFAULT_ROLE)
    .trim()
    .toLowerCase();
  if (!role) {
    return NextResponse.json({ error: "Missing role" }, { status: 400 });
  }

  const includeMissing = searchParams.get("includeMissing") === "true";
  const bucket = (searchParams.get("bucket") || "candidate-cvs").trim();
  const expiresInSeconds = parseExpiresInSeconds(searchParams);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("candidates")
    .select("id, name, email, phone, primary_role, status, created_at, cv_key")
    .eq("primary_role", role)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[CANDIDATE_CV_EXPORT] Failed to fetch candidates:", error);
    return NextResponse.json(
      { error: "Kunne ikke hente kandidater" },
      { status: 500 }
    );
  }

  const candidates = (data || []) as CandidateRow[];
  const filtered = includeMissing
    ? candidates
    : candidates.filter((candidate) => candidate.cv_key && candidate.cv_key.trim() !== "");

  const results = await Promise.all(
    filtered.map(async (candidate) => {
      const cvKey = candidate.cv_key?.trim() || "";
      let cvDownloadUrl = "";
      let cvError = "";

      if (cvKey) {
        if (cvKey.startsWith("http://") || cvKey.startsWith("https://")) {
          cvDownloadUrl = cvKey;
        } else {
          const { data: signed, error: signError } = await supabaseAdmin.storage
            .from(bucket)
            .createSignedUrl(cvKey, expiresInSeconds);

          if (signError) {
            console.warn(
              "[CANDIDATE_CV_EXPORT] Signed URL error:",
              candidate.id,
              signError.message
            );
            cvError = signError.message;
          } else {
            cvDownloadUrl = signed?.signedUrl || "";
          }
        }
      }

      return {
        candidate_id: candidate.id,
        name: candidate.name || "",
        email: candidate.email || "",
        phone: candidate.phone || "",
        role: candidate.primary_role || role,
        status: candidate.status || "",
        created_at: candidate.created_at || "",
        cv_key: cvKey,
        cv_download_url: cvDownloadUrl,
        cv_error: cvError,
      };
    })
  );

  const headers = [
    "candidate_id",
    "name",
    "email",
    "phone",
    "role",
    "status",
    "created_at",
    "cv_key",
    "cv_download_url",
    "cv_error",
  ];

  const csvLines = [
    headers.join(","),
    ...results.map((row) =>
      headers.map((header) => csvEscape(row[header as keyof typeof row])).join(",")
    ),
  ];

  const csvContent = csvLines.join("\n");
  const dateStamp = new Date().toISOString().split("T")[0];
  const filename = `candidates-${role}-cvs-${dateStamp}.csv`;

  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Total-Candidates": candidates.length.toString(),
      "X-Total-Exported": results.length.toString(),
    },
  });
}
