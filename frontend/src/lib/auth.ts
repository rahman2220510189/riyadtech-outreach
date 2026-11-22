"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./api";

export interface Me {
  id: string;
  email: string;
  lastLoginAt: string | null;
}

export const meKey = ["auth", "me"] as const;

/** The logged-in admin, or null when not logged in (401). Other errors are thrown. */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<Me | null> => {
      try {
        const res = await api.get<{ user: Me }>("/auth/me");
        return res.data.user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500 && err.status !== 0) && count < 2,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      const res = await api.post<{ user: { id: string; email: string; previousLoginAt: string | null } }>(
        "/auth/login",
        input,
      );
      return res.data.user;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: meKey });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.post("/auth/logout");
    },
    onSettled: () => {
      // Forget everything cached for this session.
      qc.clear();
    },
  });
}
