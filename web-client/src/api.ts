interface Recording {
  id: string;
  url: string;
  title: string;
  stage: string | null;
  cookieId: string | null;
  quality: string;
  startAt: string;
  stopAt: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface ApiError {
  code: string;
  message: string;
}

class ApiClient {
  async listRecordings(status?: string): Promise<Recording[]> {
    const url = status ? `/recordings?status=${encodeURIComponent(status)}` : "/recordings";
    const response = await fetch(url);
    if (!response.ok) {
      const data = (await response.json()) as { error?: ApiError };
      throw new Error(data.error?.message ?? "Failed to list recordings");
    }
    const data = (await response.json()) as { recordings: Recording[] };
    return data.recordings;
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
}

export const api = new ApiClient();
