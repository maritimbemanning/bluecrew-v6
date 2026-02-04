import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const DEFAULT_POSITION = "elektriker";
const DEFAULT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 365; // 1 year
const MAX_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 365;

type CampaignApplicationRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  segment: string | null;
  status: string | null;
  created_at: string | null;
  cv_url: string | null;
  cv_filename: string | null;
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

  const position = (searchParams.get("position") || DEFAULT_POSITION).trim().toLowerCase();
  if (!position) {
    return NextResponse.json({ error: "Missing position" }, { status: 400 });
  }

  const includeMissing = searchParams.get("includeMissing") === "true";
  const bucket = (searchParams.get("bucket") || "candidate-cvs").trim();
  const expiresInSeconds = parseExpiresInSeconds(searchParams);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("campaign_applications")
    .select(
      "id, name, email, phone, position, segment, status, created_at, cv_url, cv_filename"
    )
    .eq("position", position)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[CAMPAIGN_CV_EXPORT] Failed to fetch applications:", error);
    return NextResponse.json(
      { error: "Kunne ikke hente kampanjesoknader" },
      { status: 500 }
    );
  }

  const applications = (data || []) as CampaignApplicationRow[];
  const filtered = includeMissing
    ? applications
    : applications.filter((app) => app.cv_url && app.cv_url.trim() !== "");

  const results = await Promise.all(
    filtered.map(async (application) => {
      const cvKey = application.cv_url?.trim() || "";
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
              "[CAMPAIGN_CV_EXPORT] Signed URL error:",
              application.id,
              signError.message
            );
            cvError = signError.message;
          } else {
            cvDownloadUrl = signed?.signedUrl || "";
          }
        }
      }

      return {
        application_id: application.id,
        name: application.name || "",
        email: application.email || "",
        phone: application.phone || "",
        position: application.position || position,
        segment: application.segment || "",
        status: application.status || "",
        created_at: application.created_at || "",
        cv_key: cvKey,
        cv_filename: application.cv_filename || "",
        cv_download_url: cvDownloadUrl,
        cv_error: cvError,
      };
    })
  );

  const headers = [
    "application_id",
    "name",
    "email",
    "phone",
    "position",
    "segment",
    "status",
    "created_at",
    "cv_key",
    "cv_filename",
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
  const filename = `campaign-${position}-cvs-${dateStamp}.csv`;

  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Total-Applications": applications.length.toString(),
      "X-Total-Exported": results.length.toString(),
    },
  });
}
