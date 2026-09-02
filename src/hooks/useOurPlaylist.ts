/**
 * "Our Playlist" — a shared, couple-scoped list of songs either partner has
 * added, with a visible "who added it" attribution on every row.
 *
 * FIX (direct request: "Playlist is missing from Groic... should be for
 * both partners with who added which songs"): the DB side of this
 * (playlist_songs table, couple-scoped SELECT/INSERT/DELETE/UPDATE RLS,
 * realtime publication, position column, added_by attribution) was already
 * fully built in an earlier "Couple Playlist rebuild" phase — see
 * supabase/migrations/20260823120000_playlist_songs_partner_delete_and_realtime.sql
 * and .../20260828065415_playlist_songs_position_and_update_policy.sql. The
 * only thing actually missing was a UI inside Groic itself: the one page
 * that read this table (Playlist.tsx, /playlist) was never linked from any
 * nav and runs its own separate iframe player — a known, previously-
 * flagged duplicate, not something to resurrect. This hook is the missing
 * piece: a small, Groic-native read of the same table.
 *
 * Deliberately NOT reordering/dragging here (Playlist.tsx already owns
 * that fuller experience for anyone who navigates there directly) — this
 * is the "see what's in our playlist and who added it, right inside the
 * page you actually use to play music" surface.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export interface OurPlaylistSong {
  id: string;
  title: string;
  artist: string;
  song_url: string;
  platform: string;
  thumbnail_url: string | null;
  added_by: string;
  created_at: string;
  position: number;
}

export interface AddSongInput {
  title: string;
  artist: string;
  song_url: string;
  platform: string;
  thumbnail_url: string | null;
}

const sortByPosition = (rows: OurPlaylistSong[]): OurPlaylistSong[] =>
  [...rows].sort((a, b) => a.position - b.position);

export function useOurPlaylist() {
  const { user } = useAuth();
  const [songs, setSongs] = useState<OurPlaylistSong[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const [songsRes, profilesRes] = await Promise.all([
        supabase
          .from("playlist_songs")
          .select("id,added_by,title,artist,song_url,platform,thumbnail_url,created_at,position"),
        supabase.from("profiles").select("user_id, display_name, pet_name, partner_id"),
      ]);
      if (songsRes.error) throw songsRes.error;
      if (profilesRes.error) throw profilesRes.error;

      setSongs(sortByPosition((songsRes.data ?? []) as OurPlaylistSong[]));

      // Attribution label per user id — "You" for the current user, the
      // partner's pet name (falling back to display name) for the other
      // side, matching the label style used elsewhere in the app (Us.tsx,
      // Chat header) rather than a bare display name for both.
      const rows = (profilesRes.data ?? []) as { user_id: string; display_name: string; pet_name: string | null; partner_id: string | null }[];
      const mine = rows.find((r) => r.user_id === user.id);
      const map: Record<string, string> = {};
      rows.forEach((r) => {
        if (r.user_id === user.id) map[r.user_id] = "You";
        else if (r.user_id === mine?.partner_id) map[r.user_id] = mine?.pet_name || r.display_name || "Partner";
        else map[r.user_id] = r.display_name || "Partner";
      });
      setNames(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your playlist");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // Realtime — playlist_songs is already in the supabase_realtime
  // publication (see the migration referenced above), so a partner's
  // add/remove shows up here without a manual refresh.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`our-playlist-${user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "playlist_songs" }, (payload) => {
        setSongs((prev) => sortByPosition([...prev.filter((s) => s.id !== (payload.new as OurPlaylistSong).id), payload.new as OurPlaylistSong]));
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "playlist_songs" }, (payload) => {
        setSongs((prev) => prev.filter((s) => s.id !== (payload.old as { id: string }).id));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "playlist_songs" }, (payload) => {
        setSongs((prev) => sortByPosition(prev.map((s) => (s.id === (payload.new as OurPlaylistSong).id ? (payload.new as OurPlaylistSong) : s))));
      })
      .subscribe();
    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); channelRef.current = null; };
  }, [user]);

  const addSong = useCallback(async (input: AddSongInput) => {
    if (!user) return { error: "Not signed in" };
    // Fractional-index style position, same convention as the position
    // migration's own default — appends to the end without needing to
    // read every other row's position first.
    const { error: insertError } = await supabase.from("playlist_songs").insert({
      ...input,
      added_by: user.id,
      position: Date.now(),
    });
    if (insertError) return { error: insertError.message };
    return { error: null };
  }, [user]);

  const removeSong = useCallback(async (id: string) => {
    const { error: deleteError } = await supabase.from("playlist_songs").delete().eq("id", id);
    return { error: deleteError?.message ?? null };
  }, []);

  const attributionFor = useCallback((userId: string): string => names[userId] || "Partner", [names]);

  return { songs, loading, error, addSong, removeSong, attributionFor, reload: load };
}
