import { ref } from "vue";

export interface Recording {
  id: string;
  url: string;
  title: string;
  stage: string | null;
  cookieId: string | null;
  quality: string;
  startAt: string;
  stopAt: string;
  status: string;
  trashedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DiskSpace {
  actualBytes: number;
  projectedBytes: number;
}

interface ApiError {
  code: string;
  message: string;
}

// Populated as a side effect of any /recordings list call, which always
// carries the current disk-space figures. Shared so the App.vue header can
// show it without a second poll loop.
export const diskSpace = ref<DiskSpace | null>(null);

// Same side-effect pattern as diskSpace: populated by any /recordings list
// call, so App.vue's global poll keeps it current on every page.
export const isRecording = ref(false);

class ApiClient {
  private async fetchList(url: string, errorMessage: string): Promise<Recording[]> {
    const response = await fetch(url);
    if (!response.ok) {
      const data = (await response.json()) as { error?: ApiError };
      throw new Error(data.error?.message ?? errorMessage);
    }
    const data = (await response.json()) as {
      recordings: Recording[];
      is_recording?: boolean;
      disk?: { actual_bytes: number; projected_bytes: number };
    };
    if (data.disk) {
      diskSpace.value = { actualBytes: data.disk.actual_bytes, projectedBytes: data.disk.projected_bytes };
    }
    if (typeof data.is_recording === "boolean") {
      isRecording.value = data.is_recording;
    }
    return data.recordings;
  }

  async listRecordings(status?: string): Promise<Recording[]> {
    const url = status ? `/recordings?status=${encodeURIComponent(status)}` : "/recordings";
    return this.fetchList(url, "Failed to list recordings");
  }

  async listTrashedRecordings(): Promise<Recording[]> {
    return this.fetchList("/recordings?trashed=true", "Failed to list trash");
  }

  async getRecording(id: string): Promise<Recording> {
    const response = await fetch(`/recordings/${id}`);
    if (!response.ok) {
      const data = (await response.json()) as { error?: ApiError };
      throw new Error(data.error?.message ?? "Failed to get recording");
    }
    const data = (await response.json()) as { recording: Recording };
    return data.recording;
  }

  async createRecording(payload: unknown): Promise<Recording> {
    const response = await fetch("/recordings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = (await response.json()) as { error?: ApiError };
      throw new Error(data.error?.message ?? "Failed to create recording");
    }
    const data = (await response.json()) as { recording: Recording };
    return data.recording;
  }

  async patchRecording(id: string, payload: unknown): Promise<{ recording: Recording }> {
    const response = await fetch(`/recordings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = (await response.json()) as { error?: ApiError };
      throw new Error(data.error?.message ?? "Failed to patch recording");
    }
    return (await response.json()) as { recording: Recording };
  }

  async cancelRecording(id: string): Promise<void> {
    const response = await fetch(`/recordings/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const data = (await response.json()) as { error?: ApiError };
      throw new Error(data.error?.message ?? "Failed to cancel recording");
    }
  }

  async deleteRecordingFile(id: string): Promise<void> {
    const response = await fetch(`/recordings/${id}/file`, { method: "DELETE" });
    if (!response.ok) {
      const data = (await response.json()) as { error?: ApiError };
      throw new Error(data.error?.message ?? "Failed to delete recording file");
    }
  }

  async restoreRecording(id: string): Promise<Recording> {
    const response = await fetch(`/recordings/${id}/restore`, { method: "POST" });
    if (!response.ok) {
      const data = (await response.json()) as { error?: ApiError };
      throw new Error(data.error?.message ?? "Failed to restore recording");
    }
    const data = (await response.json()) as { recording: Recording };
    return data.recording;
  }

  async lookupOembed(url: string): Promise<{ authorName: string | null; title: string | null }> {
    const response = await fetch(`/recordings/oembed?url=${encodeURIComponent(url)}`);
    if (!response.ok) {
      throw new Error("Failed to look up stream info");
    }
    const data = (await response.json()) as { author_name: string | null; title: string | null };
    return { authorName: data.author_name, title: data.title };
  }

  async lookupAvailableFormats(
    url: string
  ): Promise<{ available: boolean; qualities: string[]; bestMatches: string | null }> {
    const response = await fetch(`/recordings/formats?url=${encodeURIComponent(url)}`);
    if (!response.ok) {
      throw new Error("Failed to look up available formats");
    }
    const data = (await response.json()) as {
      available: boolean;
      qualities: string[];
      best_matches: string | null;
    };
    return { available: data.available, qualities: data.qualities, bestMatches: data.best_matches };
  }

  async permanentlyDeleteRecording(id: string): Promise<void> {
    const response = await fetch(`/recordings/${id}/trash`, { method: "DELETE" });
    if (!response.ok) {
      const data = (await response.json()) as { error?: ApiError };
      throw new Error(data.error?.message ?? "Failed to permanently delete recording");
    }
  }
}

export const api = new ApiClient();
