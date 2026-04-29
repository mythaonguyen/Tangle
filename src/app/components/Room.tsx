import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabaseClient } from '../lib/realtime';

interface Topic {
  id: string;
  text: string;
  children: Topic[];
  unlockChapter?: number;
}

interface DeviceProfile {
  id: string;
  initials: string;
  color: string;
  transferCode: string;
  isAdmin: boolean;
}

interface ProgressByUser {
  [userId: string]: number;
}

interface Book {
  id: number;
  name: string;
  genre: string;
  author: string;
  description: string;
  coverColor: string;
  coverImage?: string;
  totalChapters: number;
  progressByUser: ProgressByUser;
  topics: Topic[];
}

interface RoomState {
  books: Book[];
  selectedBookId: number;
  creatorId: string;
  trustMode: 'open' | 'creator_only';
  profiles: Record<string, Pick<DeviceProfile, 'id' | 'initials' | 'color'>>;
  roomVersion?: number;
}

interface RoomProgressRow {
  room_id: string;
  book_id: number;
  user_id: string;
  progress: number;
}

/** Legacy demo seeded 15% for a single reader; normalize to 0% */
const migrateLegacyProgress = (book: Book): Book => {
  const entries = Object.entries(book.progressByUser);
  if (entries.length === 1 && entries[0][1] === 15) {
    return { ...book, progressByUser: { [entries[0][0]]: 0 } };
  }
  return book;
};

const DEFAULT_COVER_COLORS = ['#e8b4c8', '#a8c5e8', '#b4e8b4', '#ffc4a5', '#d4a5d4'];
const PROFILE_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#ec4899'];
const DISCUSSION_BUBBLE_COLORS = ['#fde2e4', '#d1e7dd', '#fff3bf', '#e9ecef'];

const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;
const TARGET_IMAGE_BYTES = 220 * 1024;
const MAX_IMAGE_DIMENSION = 900;
const DEVICE_PROFILE_KEY = 'tangle-device-profile-v1';
const ROOM_SYNC_SOURCE = `tab-${Math.random().toString(36).slice(2, 8)}`;
const ROOM_PROGRESS_TABLE = 'room_progress';

const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));
const makeTransferCode = () =>
  `${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}-${Math.random()
    .toString(36)
    .slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

const toInitials = (text: string) =>
  text
    .trim()
    .split(/\s+/)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2) || 'ME';

const getChapterFromProgress = (progress: number, totalChapters: number) => {
  const normalizedTotal = Math.max(1, totalChapters);
  return Math.max(0, Math.floor((clampPercent(progress) / 100) * normalizedTotal));
};

const waitForImageLoad = (image: HTMLImageElement) =>
  new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Image failed to load.'));
  });

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read compressed image.'));
    };
    reader.onerror = () => reject(new Error('Could not read compressed image.'));
    reader.readAsDataURL(blob);
  });

const canvasToJpegBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Compression failed.'))),
      'image/jpeg',
      quality
    );
  });

const compressImageFile = async (file: File): Promise<string> => {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await waitForImageLoad(image);

    let width = image.naturalWidth;
    let height = image.naturalHeight;
    const largestEdge = Math.max(width, height);
    if (largestEdge > MAX_IMAGE_DIMENSION) {
      const scale = MAX_IMAGE_DIMENSION / largestEdge;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not supported.');

    for (let pass = 0; pass < 4; pass += 1) {
      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);

      for (let quality = 0.85; quality >= 0.45; quality -= 0.1) {
        const blob = await canvasToJpegBlob(canvas, quality);
        if (blob.size <= TARGET_IMAGE_BYTES) return blobToDataUrl(blob);
      }

      width = Math.max(320, Math.round(width * 0.85));
      height = Math.max(320, Math.round(height * 0.85));
    }

    return blobToDataUrl(await canvasToJpegBlob(canvas, 0.45));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

const buildDefaultBooks = (ownerId: string): Book[] => [
  {
    id: 1,
    name: 'The Silent Echo',
    genre: 'Fiction',
    author: 'Jane Doe',
    description: 'A captivating tale of mystery and self-discovery in a small coastal town.',
    coverColor: '#e8b4c8',
    totalChapters: 20,
    progressByUser: { [ownerId]: 0 },
    topics: [
      {
        id: '1',
        text: 'What stood out in chapter 1?',
        unlockChapter: 1,
        children: [{ id: '1-1', text: 'How does the setting affect the mood?', unlockChapter: 2, children: [] }],
      },
    ],
  },
];

export function Room() {
  const navigate = useNavigate();
  const { roomId: routeRoomId } = useParams();
  const supabaseChannelRef = useRef<RealtimeChannel | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  const [profile, setProfile] = useState<DeviceProfile | null>(null);
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [profileNameInput, setProfileNameInput] = useState('');
  const [profileColorInput, setProfileColorInput] = useState(PROFILE_COLORS[0]);
  const [reclaimCodeInput, setReclaimCodeInput] = useState('');
  const [reclaimStatus, setReclaimStatus] = useState('');

  const [books, setBooks] = useState<Book[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<number>(0);
  const [creatorId, setCreatorId] = useState('');
  const [trustMode, setTrustMode] = useState<'open' | 'creator_only'>('open');
  const [profilesInRoom, setProfilesInRoom] = useState<Record<string, Pick<DeviceProfile, 'id' | 'initials' | 'color'>>>({});
  const [isRoomLoaded, setIsRoomLoaded] = useState(false);

  const [hoveredBook, setHoveredBook] = useState<number | null>(null);
  const [showBookForm, setShowBookForm] = useState(false);
  const [newBookName, setNewBookName] = useState('');
  const [newBookAuthor, setNewBookAuthor] = useState('');
  const [newBookGenre, setNewBookGenre] = useState('');
  const [newBookDescription, setNewBookDescription] = useState('');
  const [newBookTotalChapters, setNewBookTotalChapters] = useState(20);
  const [newBookCoverColor, setNewBookCoverColor] = useState(DEFAULT_COVER_COLORS[0]);
  const [newBookCoverImage, setNewBookCoverImage] = useState<string | undefined>(undefined);
  const [newBookCoverError, setNewBookCoverError] = useState('');

  const [discussionDraft, setDiscussionDraft] = useState('');
  const [discussionParentId, setDiscussionParentId] = useState<string | null>(null);
  const [discussionUnlockChapter, setDiscussionUnlockChapter] = useState(1);
  const [showDiscussionForm, setShowDiscussionForm] = useState(false);
  const [spoilerOverrides, setSpoilerOverrides] = useState<Record<string, boolean>>({});

  const activeRoomId = routeRoomId ?? '';

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedAccent = window.localStorage.getItem('tangle-accent-color');
    if (savedAccent) {
      document.documentElement.style.setProperty('--tangle-accent', savedAccent);
    }
  }, []);

  useEffect(() => {
    if (!routeRoomId) {
      const generatedRoomId = Math.random().toString(36).slice(2, 8).toUpperCase();
      navigate(`/room/${generatedRoomId}`, { replace: true });
    }
  }, [navigate, routeRoomId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const existing = window.localStorage.getItem(DEVICE_PROFILE_KEY);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as DeviceProfile;
        if (parsed.id && parsed.initials && parsed.color && parsed.transferCode) {
          setProfile(parsed);
          setProfileNameInput(parsed.initials);
          setProfileColorInput(parsed.color);
          return;
        }
      } catch {
        // Ignore malformed profile and re-create.
      }
    }

    const created: DeviceProfile = {
      id: `u-${Math.random().toString(36).slice(2, 10)}`,
      initials: 'ME',
      color: PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)],
      transferCode: makeTransferCode(),
      isAdmin: false,
    };
    window.localStorage.setItem(DEVICE_PROFILE_KEY, JSON.stringify(created));
    setProfile(created);
    setProfileNameInput(created.initials);
    setProfileColorInput(created.color);
    setShowProfileForm(true);
  }, []);

  const canMutateBooks = useMemo(() => {
    if (!profile) return false;
    if (trustMode === 'open') return true;
    return profile.id === creatorId || profile.isAdmin;
  }, [creatorId, profile, trustMode]);

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? null,
    [books, selectedBookId]
  );

  const currentUserChapter = selectedBook && profile
    ? getChapterFromProgress(selectedBook.progressByUser[profile.id] ?? 0, selectedBook.totalChapters)
    : 0;

  const shareableLink =
    typeof window === 'undefined'
      ? ''
      : `${window.location.origin}${import.meta.env.BASE_URL}#/room/${activeRoomId}`;

  const persistRoomLocal = (next: RoomState) => {
    if (!activeRoomId || typeof window === 'undefined') return;
    window.localStorage.setItem(
      `tangle-room-${activeRoomId}`,
      JSON.stringify({ ...next, roomVersion: 1 })
    );
  };

  const buildRoomState = (
    nextBooks: Book[],
    nextSelectedBookId: number,
    nextCreatorId: string,
    nextTrustMode: 'open' | 'creator_only',
    nextProfiles: Record<string, Pick<DeviceProfile, 'id' | 'initials' | 'color'>>
  ): RoomState => ({
    books: nextBooks,
    selectedBookId: nextSelectedBookId,
    creatorId: nextCreatorId,
    trustMode: nextTrustMode,
    profiles: nextProfiles,
  });

  const applyRoomState = (state: RoomState) => {
    setBooks(state.books);
    setSelectedBookId(state.selectedBookId);
    setCreatorId(state.creatorId);
    setTrustMode(state.trustMode);
    setProfilesInRoom(state.profiles ?? {});
  };

  const broadcastState = (state: RoomState) => {
    const payload = { source: ROOM_SYNC_SOURCE, roomId: activeRoomId, state };
    broadcastChannelRef.current?.postMessage(payload);
    if (supabaseChannelRef.current) {
      supabaseChannelRef.current.send({ type: 'broadcast', event: 'room_state', payload });
    }
  };

  const commitRoomState = (
    updater: (current: RoomState) => RoomState,
    shouldBroadcast = true
  ) => {
    const current = buildRoomState(books, selectedBookId, creatorId, trustMode, profilesInRoom);
    const next = updater(current);
    applyRoomState(next);
    persistRoomLocal(next);
    if (shouldBroadcast) broadcastState(next);
  };

  useEffect(() => {
    if (!profile || !activeRoomId || typeof window === 'undefined') return;

    let cancelled = false;
    setIsRoomLoaded(false);
    const hydrate = (incoming: RoomState): RoomState => {
      const rawBooks = Array.isArray(incoming.books) ? incoming.books : buildDefaultBooks(profile.id);
      const parsedBooks = rawBooks.map(migrateLegacyProgress);
      const parsedProfiles = incoming.profiles ?? {};
      return {
        books: parsedBooks,
        selectedBookId: incoming.selectedBookId || parsedBooks[0]?.id || 0,
        creatorId: incoming.creatorId || profile.id,
        trustMode: incoming.trustMode || 'open',
        profiles: {
          ...parsedProfiles,
          [profile.id]: { id: profile.id, initials: profile.initials, color: profile.color },
        },
      };
    };

    const loadRoom = async () => {
      const key = `tangle-room-${activeRoomId}`;
      const saved = window.localStorage.getItem(key);
      if (saved) {
        try {
          const nextState = hydrate(JSON.parse(saved) as RoomState);
          if (!cancelled) {
            applyRoomState(nextState);
            persistRoomLocal(nextState);
            setIsRoomLoaded(true);
          }
          return;
        } catch {
          // fallback to default room state
        }
      }

      const defaultBooks = buildDefaultBooks(profile.id);
      const initial: RoomState = {
        books: defaultBooks,
        selectedBookId: defaultBooks[0]?.id ?? 0,
        creatorId: profile.id,
        trustMode: 'open',
        profiles: { [profile.id]: { id: profile.id, initials: profile.initials, color: profile.color } },
      };
      if (!cancelled) {
        applyRoomState(initial);
        persistRoomLocal(initial);
        setIsRoomLoaded(true);
      }
    };

    void loadRoom();

    return () => {
      cancelled = true;
    };
  }, [activeRoomId, profile]);

  const applyProgressRows = (baseBooks: Book[], rows: RoomProgressRow[]) =>
    baseBooks.map((book) => {
      const bookRows = rows.filter((row) => row.book_id === book.id);
      if (bookRows.length === 0) return book;
      const nextProgress = { ...book.progressByUser };
      for (const row of bookRows) {
        nextProgress[row.user_id] = clampPercent(row.progress);
      }
      return { ...book, progressByUser: nextProgress };
    });

  useEffect(() => {
    if (!activeRoomId || !isRoomLoaded) return;
    const client = getSupabaseClient();
    if (!client) return;

    let cancelled = false;
    const loadProgress = async () => {
      const { data, error } = await client
        .from(ROOM_PROGRESS_TABLE)
        .select('room_id, book_id, user_id, progress')
        .eq('room_id', activeRoomId);

      if (cancelled || error || !data) return;
      setBooks((current) => applyProgressRows(current, data as RoomProgressRow[]));
    };

    void loadProgress();
    return () => {
      cancelled = true;
    };
  }, [activeRoomId, isRoomLoaded]);

  useEffect(() => {
    if (!activeRoomId || typeof window === 'undefined') return;
    const channel = new BroadcastChannel(`tangle-room-${activeRoomId}`);
    broadcastChannelRef.current = channel;
    channel.onmessage = (event) => {
      const payload = event.data as { source: string; roomId: string; state: RoomState };
      if (!payload || payload.source === ROOM_SYNC_SOURCE || payload.roomId !== activeRoomId) return;
      applyRoomState(payload.state);
      persistRoomLocal(payload.state);
    };
    return () => {
      channel.close();
      broadcastChannelRef.current = null;
    };
  }, [activeRoomId]);

  useEffect(() => {
    if (!activeRoomId) return;
    const client = getSupabaseClient();
    if (!client) return;

    const channel = client.channel(`room-${activeRoomId}`, { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'room_state' }, ({ payload }) => {
      const data = payload as { source: string; roomId: string; state: RoomState };
      if (!data || data.source === ROOM_SYNC_SOURCE || data.roomId !== activeRoomId) return;
      applyRoomState(data.state);
      persistRoomLocal(data.state);
    });
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: ROOM_PROGRESS_TABLE, filter: `room_id=eq.${activeRoomId}` },
      (payload) => {
        const row = payload.new as Partial<RoomProgressRow> | null;
        if (!row || typeof row.book_id !== 'number' || typeof row.user_id !== 'string') return;
        const userId = row.user_id;
        const progress = clampPercent(Number(row.progress ?? 0));
        setBooks((current) =>
          current.map((book) =>
            book.id === row.book_id
              ? {
                  ...book,
                  progressByUser: {
                    ...book.progressByUser,
                    [userId]: progress,
                  },
                }
              : book
          )
        );
      }
    );
    channel.subscribe();
    supabaseChannelRef.current = channel;

    return () => {
      if (supabaseChannelRef.current) {
        client.removeChannel(supabaseChannelRef.current);
        supabaseChannelRef.current = null;
      }
    };
  }, [activeRoomId]);

  const upsertProgressRemote = async (bookId: number, userId: string, progress: number) => {
    if (!activeRoomId) return;
    const client = getSupabaseClient();
    if (!client) return;

    const { error } = await client.from(ROOM_PROGRESS_TABLE).upsert(
      {
        room_id: activeRoomId,
        book_id: bookId,
        user_id: userId,
        progress: clampPercent(progress),
      },
      { onConflict: 'room_id,book_id,user_id' }
    );
    if (error) {
      console.error('Failed to update room progress:', error.message);
    }
  };

  const saveProfile = () => {
    if (!profile || typeof window === 'undefined') return;
    const next: DeviceProfile = {
      ...profile,
      initials: toInitials(profileNameInput),
      color: profileColorInput,
    };
    window.localStorage.setItem(DEVICE_PROFILE_KEY, JSON.stringify(next));
    setProfile(next);
    setShowProfileForm(false);
    commitRoomState((current) => ({
      ...current,
      profiles: {
        ...current.profiles,
        [next.id]: { id: next.id, initials: next.initials, color: next.color },
      },
    }));
  };

  const reclaimProfile = () => {
    if (!profile || typeof window === 'undefined') return;
    const typed = reclaimCodeInput.trim().toUpperCase();
    if (!typed) return;
    const raw = window.localStorage.getItem(DEVICE_PROFILE_KEY);
    if (!raw) return;
    const current = JSON.parse(raw) as DeviceProfile;
    if (current.transferCode !== typed) {
      setReclaimStatus('Transfer code does not match this device profile.');
      return;
    }
    const reclaimed = { ...current, isAdmin: true };
    window.localStorage.setItem(DEVICE_PROFILE_KEY, JSON.stringify(reclaimed));
    setProfile(reclaimed);
    setReclaimStatus('Reclaimed. Admin mode enabled on this device.');
  };

  const handleCoverUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setNewBookCoverError('');
    if (!file.type.startsWith('image/')) {
      setNewBookCoverError('Please upload a valid image file.');
      event.target.value = '';
      return;
    }
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      setNewBookCoverError('Image is too large. Max upload size is 5 MB.');
      event.target.value = '';
      return;
    }

    try {
      const compressed = await compressImageFile(file);
      setNewBookCoverImage(compressed);
    } catch {
      setNewBookCoverError('Could not process this image.');
    } finally {
      event.target.value = '';
    }
  };

  const addBook = () => {
    if (!profile || !canMutateBooks) return;
    const name = newBookName.trim();
    const author = newBookAuthor.trim();
    const genre = newBookGenre.trim() || 'General';
    const description = newBookDescription.trim();
    const totalChapters = Math.max(1, Math.floor(newBookTotalChapters));
    if (!name || !author || !description) return;

    const newBook: Book = {
      id: Date.now(),
      name,
      author,
      genre,
      description,
      coverColor: newBookCoverColor,
      coverImage: newBookCoverImage,
      totalChapters,
      progressByUser: { [profile.id]: 0 },
      topics: [],
    };

    commitRoomState((current) => ({
      ...current,
      books: [...current.books, newBook],
      selectedBookId: newBook.id,
    }));

    setShowBookForm(false);
    setNewBookName('');
    setNewBookAuthor('');
    setNewBookGenre('');
    setNewBookDescription('');
    setNewBookTotalChapters(20);
    setNewBookCoverColor(DEFAULT_COVER_COLORS[0]);
    setNewBookCoverImage(undefined);
    setNewBookCoverError('');
  };

  const deleteBook = (bookId: number) => {
    if (!canMutateBooks) return;
    commitRoomState((current) => {
      const nextBooks = current.books.filter((book) => book.id !== bookId);
      return {
        ...current,
        books: nextBooks,
        selectedBookId:
          current.selectedBookId === bookId ? nextBooks[0]?.id ?? 0 : current.selectedBookId,
      };
    });
  };

  const incrementMyProgress = (bookId: number) => {
    if (!profile) return;
    const currentBook = books.find((book) => book.id === bookId);
    const nextProgress = clampPercent((currentBook?.progressByUser[profile.id] ?? 0) + 5);
    commitRoomState((current) => {
      const nextBooks = current.books.map((book) => {
        if (book.id !== bookId) return book;
        return {
          ...book,
          progressByUser: {
            ...book.progressByUser,
            [profile.id]: nextProgress,
          },
        };
      });
      return {
        ...current,
        books: nextBooks,
        profiles: {
          ...current.profiles,
          [profile.id]: { id: profile.id, initials: profile.initials, color: profile.color },
        },
      };
    });
    void upsertProgressRemote(bookId, profile.id, nextProgress);
  };

  const openDiscussionForm = (parentId: string | null = null) => {
    setDiscussionParentId(parentId);
    setDiscussionDraft('');
    setDiscussionUnlockChapter(Math.max(1, currentUserChapter || 1));
    setShowDiscussionForm(true);
  };

  const closeDiscussionForm = () => {
    setShowDiscussionForm(false);
    setDiscussionParentId(null);
    setDiscussionDraft('');
    setDiscussionUnlockChapter(1);
  };

  const addDiscussion = () => {
    if (!selectedBook) return;
    const text = discussionDraft.trim();
    if (!text) return;
    const newTopic: Topic = {
      id: Date.now().toString(),
      text,
      unlockChapter: Math.max(1, discussionUnlockChapter),
      children: [],
    };

    commitRoomState((current) => {
      const nextBooks = current.books.map((book) => {
        if (book.id !== selectedBook.id) return book;
        if (!discussionParentId) {
          return { ...book, topics: [...book.topics, newTopic] };
        }
        const inject = (topics: Topic[]): Topic[] =>
          topics.map((topic) => {
            if (topic.id === discussionParentId) {
              return { ...topic, children: [...topic.children, newTopic] };
            }
            return { ...topic, children: inject(topic.children) };
          });
        return { ...book, topics: inject(book.topics) };
      });
      return { ...current, books: nextBooks };
    });
    closeDiscussionForm();
  };

  const deleteTopic = (topicId: string) => {
    if (!selectedBook) return;
    const prune = (topics: Topic[]): Topic[] =>
      topics
        .filter((topic) => topic.id !== topicId)
        .map((topic) => ({ ...topic, children: prune(topic.children) }));

    commitRoomState((current) => ({
      ...current,
      books: current.books.map((book) =>
        book.id === selectedBook.id ? { ...book, topics: prune(book.topics) } : book
      ),
    }));
  };

  const copyShareLink = async () => {
    if (!shareableLink) return;
    try {
      await navigator.clipboard.writeText(shareableLink);
    } catch {
      // noop
    }
  };

  const isTopicLocked = (topic: Topic) => {
    const unlockChapter = topic.unlockChapter ?? 1;
    return currentUserChapter < unlockChapter && !spoilerOverrides[topic.id];
  };

  const renderTree = (topics: Topic[], depth = 0): JSX.Element[] =>
    topics.map((topic) => {
      const locked = isTopicLocked(topic);
      const unlockChapter = topic.unlockChapter ?? 1;
      const bubbleColor = DISCUSSION_BUBBLE_COLORS[depth % DISCUSSION_BUBBLE_COLORS.length];
      return (
        <div key={topic.id} className="mb-2">
          <div className="relative flex gap-2 items-start">
            <div className="w-2 shrink-0 rounded-full bg-black/25 mt-3" aria-hidden />
            <div className="flex-1 min-w-0">
              <div
                className="relative rounded-2xl px-3 py-2.5 shadow-sm border border-black/5"
                style={{ backgroundColor: bubbleColor }}
              >
                <div
                  className="flex items-start gap-2"
                  style={{
                    filter: locked ? 'blur(8px)' : 'none',
                    pointerEvents: locked ? 'none' : 'auto',
                  }}
                >
                  <div className="flex-1 min-w-0 text-sm text-[#2d2d2d] leading-snug">
                    <div className="font-medium">{topic.text}</div>
                    <div className="text-[11px] text-gray-600 mt-1">Unlock chapter {unlockChapter}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => openDiscussionForm(topic.id)}
                      className="w-7 h-7 rounded-full bg-white/80 border border-rose-200/80 text-rose-700 flex items-center justify-center text-sm hover:bg-white"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteTopic(topic.id)}
                      className="w-7 h-7 rounded-full bg-white/80 border border-red-200/80 text-red-600 flex items-center justify-center text-xs hover:bg-white"
                    >
                      ×
                    </button>
                  </div>
                </div>
                {locked && (
                  <div className="absolute inset-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-white/80 backdrop-blur-[2px] rounded-2xl px-3 py-2">
                    <div className="text-[11px] font-medium text-gray-800">
                      🔒 Locked: Reach Chapter {unlockChapter} to view.
                    </div>
                    <button
                      type="button"
                      onClick={() => setSpoilerOverrides((prev) => ({ ...prev, [topic.id]: true }))}
                      className="text-[11px] px-2 py-1 rounded-full bg-[#2d2d2d] text-white hover:bg-black/85 shrink-0"
                    >
                      Show anyway
                    </button>
                  </div>
                )}
              </div>
              {topic.children.length > 0 && (
                <div className="ml-3 mt-2 pl-3 border-l-2 border-dashed border-black/15 space-y-2">
                  {renderTree(topic.children, depth + 1)}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    });

  if (!profile || !isRoomLoaded) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#faf8f3] text-[#5c534c] text-sm">
        <div className="tangle-glass-strong rounded-3xl px-8 py-6 shadow-lg">Loading room…</div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex relative overflow-hidden bg-[#faf8f3]">
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute -top-20 -left-20 w-[55%] h-[55%] rounded-full opacity-50"
          style={{ background: 'radial-gradient(circle, #f8d7e4 0%, transparent 70%)', filter: 'blur(40px)' }}
        />
        <div
          className="absolute top-1/3 right-0 w-[45%] h-[50%] rounded-full opacity-45"
          style={{ background: 'radial-gradient(circle, #dcecf5 0%, transparent 70%)', filter: 'blur(38px)' }}
        />
        <div
          className="absolute bottom-0 left-1/4 w-[50%] h-[45%] rounded-full opacity-40"
          style={{ background: 'radial-gradient(circle, #fff3d6 0%, transparent 70%)', filter: 'blur(36px)' }}
        />
      </div>

      <div className="relative z-10 flex w-full h-full">
        <div className="flex-1 min-w-0 p-5 sm:p-6 pb-28 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div className="tangle-glass text-xs sm:text-sm text-[#3d3d3d] rounded-2xl px-3 py-2 max-w-[min(100%,28rem)] leading-snug">
              {trustMode === 'open'
                ? 'Trust mode: anyone with link can add/delete'
                : 'Creator mode: add/delete restricted to creator/admin'}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  commitRoomState((current) => ({
                    ...current,
                    trustMode: current.trustMode === 'open' ? 'creator_only' : 'open',
                  }))
                }
                className="text-xs px-3 py-2 rounded-full tangle-soft-btn font-semibold shadow-sm"
              >
                Toggle trust mode
              </button>
              <button
                type="button"
                onClick={() => setShowProfileForm(true)}
                className="text-xs px-3 py-2 rounded-full tangle-soft-btn font-semibold shadow-sm"
              >
                Edit profile
              </button>
            </div>
          </div>

          <div className="h-full overflow-y-auto pr-2">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-5">
              {books.map((book) => {
                const profileParticipants = Object.values(profilesInRoom);
                const fallbackParticipants = Object.keys(book.progressByUser)
                  .filter((id) => !profilesInRoom[id])
                  .map((id) => ({ id, initials: id.slice(0, 2).toUpperCase(), color: '#6b7280' }));
                const participants = [...profileParticipants, ...fallbackParticipants];
                const avg =
                  participants.length === 0
                    ? 0
                    : Math.round(
                        participants.reduce((sum, p) => sum + (book.progressByUser[p.id] ?? 0), 0) /
                          participants.length
                      );

                return (
                  <div
                    key={book.id}
                    onClick={() => setSelectedBookId(book.id)}
                    onMouseEnter={() => setHoveredBook(book.id)}
                    onMouseLeave={() => setHoveredBook(null)}
                    className={`tangle-glass-strong rounded-[1.75rem] p-4 sm:p-5 cursor-pointer transition-shadow ${
                      selectedBook?.id === book.id ? 'ring-2 ring-rose-300/80 shadow-xl' : 'shadow-md hover:shadow-lg'
                    }`}
                  >
                    {book.coverImage ? (
                      <img
                        src={book.coverImage}
                        alt={book.name}
                        className="w-full h-44 rounded-2xl mb-3 object-cover shadow-inner border border-white/50"
                      />
                    ) : (
                      <div
                        className="w-full h-44 rounded-2xl mb-3 flex items-center justify-center px-4 text-center shadow-inner border border-white/40"
                        style={{ backgroundColor: book.coverColor }}
                      >
                        <span className="text-black font-semibold text-base drop-shadow-sm">{book.name}</span>
                      </div>
                    )}
                    <div className="text-sm text-[#2d2d2d]">
                      <p className="font-semibold">{book.genre}</p>
                      <p className="text-gray-700">Author: {book.author}</p>
                      <p className="text-gray-700">Chapters: {book.totalChapters}</p>
                      {hoveredBook === book.id && <p className="text-gray-600 text-xs mt-1.5 leading-relaxed">{book.description}</p>}
                    </div>

                    <div className="mt-4">
                      <div className="flex items-center justify-between text-[11px] font-semibold text-gray-700 mb-2">
                        <span>Reading progress</span>
                        <span>You: {book.progressByUser[profile.id] ?? 0}%</span>
                      </div>
                      <div className="relative pt-7 pb-2">
                        <div className="h-3 rounded-full bg-gradient-to-b from-rose-50 to-rose-100/90 shadow-inner border border-rose-100/80 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-rose-200/70 transition-[width] duration-300"
                            style={{ width: `${avg}%` }}
                          />
                        </div>
                        {participants.map((person) => {
                          const progress = clampPercent(book.progressByUser[person.id] ?? 0);
                          const isSelf = person.id === profile.id;
                          return (
                            <div
                              key={person.id}
                              className="absolute top-0 -translate-x-1/2 flex flex-col items-center"
                              style={{ left: `${progress}%` }}
                              title={`${person.initials}: ${progress}%`}
                            >
                              {isSelf && (
                                <span className="text-[9px] font-bold text-gray-600 mb-0.5 tracking-wide">ME</span>
                              )}
                              <div
                                className="w-7 h-7 rounded-full text-[10px] text-white font-bold flex items-center justify-center border-2 border-white shadow-md"
                                style={{
                                  backgroundColor: person.color,
                                  boxShadow: '0 4px 10px rgba(0,0,0,0.12), inset 0 2px 0 rgba(255,255,255,0.35)',
                                }}
                              >
                                {person.initials}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="text-[11px] text-gray-600">Group average: {avg}%</div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          incrementMyProgress(book.id);
                        }}
                        className="mt-3 w-full py-2 rounded-full tangle-soft-btn text-xs font-semibold shadow-sm"
                      >
                        + Progress
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteBook(book.id);
                      }}
                      disabled={!canMutateBooks}
                      className="mt-3 w-full py-2 rounded-full text-xs font-semibold bg-rose-100/90 text-rose-800 border border-rose-200/60 hover:bg-rose-200/80 disabled:opacity-40"
                    >
                      Delete book
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="w-[min(100%,500px)] shrink-0 tangle-glass-strong m-3 sm:m-4 mb-28 rounded-[1.75rem] p-5 sm:p-6 overflow-y-auto relative border border-white/50 shadow-lg">
          {selectedBook ? (
            <>
              <div className="mb-5">
                <h2 className="text-xl font-semibold text-[#2d2d2d]">{selectedBook.name}</h2>
                <p className="text-xs text-gray-600 mt-1.5">
                  You are on Chapter {currentUserChapter} / {selectedBook.totalChapters}
                </p>
              </div>
              <div className="mb-2">
                <div className="flex items-center gap-2 mb-4">
                  <div className="text-lg font-semibold text-[#2d2d2d]">Discussion Tree</div>
                  <button
                    type="button"
                    onClick={() => openDiscussionForm(null)}
                    className="w-8 h-8 rounded-full tangle-soft-btn flex items-center justify-center text-base font-bold shadow-sm"
                  >
                    +
                  </button>
                </div>
                {selectedBook.topics.length > 0 ? (
                  renderTree(selectedBook.topics)
                ) : (
                  <div className="text-sm text-gray-500">No discussions yet.</div>
                )}
              </div>
            </>
          ) : (
            <div className="h-full min-h-[200px] flex items-center justify-center text-gray-500 text-sm text-center px-4">
              Add or select a book to view discussions
            </div>
          )}
        </div>
      </div>

      {showBookForm && (
        <div className="fixed bottom-24 left-4 right-4 z-20 lg:left-6 lg:right-[calc(500px+1.5rem)]">
          <div className="tangle-glass-strong rounded-3xl p-5 shadow-xl border border-white/60 max-h-[70vh] overflow-y-auto">
            <div className="text-sm font-semibold text-[#2d2d2d] mb-3">Add a book</div>
            <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
              <input type="text" placeholder="Book name" value={newBookName} onChange={(event) => setNewBookName(event.target.value)} className="px-3 py-2.5 rounded-2xl border border-white/70 bg-white/60 outline-none text-sm" />
              <input type="text" placeholder="Author" value={newBookAuthor} onChange={(event) => setNewBookAuthor(event.target.value)} className="px-3 py-2.5 rounded-2xl border border-white/70 bg-white/60 outline-none text-sm" />
              <input type="text" placeholder="Genre" value={newBookGenre} onChange={(event) => setNewBookGenre(event.target.value)} className="px-3 py-2.5 rounded-2xl border border-white/70 bg-white/60 outline-none text-sm" />
              <input type="text" placeholder="Description" value={newBookDescription} onChange={(event) => setNewBookDescription(event.target.value)} className="px-3 py-2.5 rounded-2xl border border-white/70 bg-white/60 outline-none text-sm" />
              <input type="number" min={1} value={newBookTotalChapters} onChange={(event) => setNewBookTotalChapters(Number(event.target.value) || 1)} className="px-3 py-2.5 rounded-2xl border border-white/70 bg-white/60 outline-none text-sm" />
            </div>

            <div className="mt-3">
              <label className="block text-xs font-semibold mb-2 text-[#2d2d2d]">Upload a cover image (optional)</label>
              <input type="file" accept="image/*" onChange={handleCoverUpload} className="text-sm" />
              {newBookCoverImage && (
                <button type="button" onClick={() => setNewBookCoverImage(undefined)} className="mt-2 px-3 py-1.5 text-xs rounded-full bg-white/70 border border-gray-200 hover:bg-white">
                  Remove uploaded image
                </button>
              )}
              {newBookCoverError && <p className="text-xs text-red-600 mt-2">{newBookCoverError}</p>}
            </div>

            <div className="mt-3">
              <div className="text-xs font-semibold mb-2 text-[#2d2d2d]">Default cover colors</div>
              <div className="flex items-center gap-2 flex-wrap">
                {DEFAULT_COVER_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => {
                      setNewBookCoverColor(color);
                      setNewBookCoverImage(undefined);
                      setNewBookCoverError('');
                    }}
                    className={`w-7 h-7 rounded-full border-2 shadow-sm ${newBookCoverColor === color && !newBookCoverImage ? 'border-rose-400 scale-105' : 'border-white'}`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <button type="button" onClick={addBook} disabled={!canMutateBooks} className="px-4 py-2 rounded-full tangle-soft-btn text-sm font-semibold disabled:opacity-40">
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowBookForm(false);
                  setNewBookCoverImage(undefined);
                  setNewBookCoverColor(DEFAULT_COVER_COLORS[0]);
                  setNewBookCoverError('');
                }}
                className="px-4 py-2 rounded-full bg-white/70 border border-gray-200 text-sm font-semibold hover:bg-white"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showDiscussionForm && (
        <div className="fixed inset-0 bg-[#faf8f3]/80 backdrop-blur-sm flex items-center justify-center p-4 z-20">
          <div className="w-full max-w-sm tangle-glass-strong rounded-3xl shadow-xl p-5 border border-white/60">
            <div className="text-sm font-semibold text-[#2d2d2d] mb-2">{discussionParentId ? 'Add sub-discussion' : 'Add discussion'}</div>
            <textarea value={discussionDraft} onChange={(event) => setDiscussionDraft(event.target.value)} placeholder="Enter discussion text" className="w-full h-24 px-3 py-2 rounded-2xl border border-white/70 bg-white/60 outline-none resize-none text-sm" />
            <div className="mt-2">
              <label className="text-xs font-semibold mb-1 block text-[#2d2d2d]">Unlock chapter</label>
              <input
                type="number"
                min={1}
                max={selectedBook?.totalChapters ?? 999}
                value={discussionUnlockChapter}
                onChange={(event) => setDiscussionUnlockChapter(Number(event.target.value) || 1)}
                className="w-full px-3 py-2 rounded-2xl border border-white/70 bg-white/60 outline-none text-sm"
              />
            </div>
            <div className="flex gap-2 mt-4">
              <button type="button" onClick={addDiscussion} className="px-4 py-2 rounded-full tangle-soft-btn text-sm font-semibold">
                Save
              </button>
              <button type="button" onClick={closeDiscussionForm} className="px-4 py-2 rounded-full bg-white/70 border border-gray-200 text-sm font-semibold hover:bg-white">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showProfileForm && (
        <div className="fixed inset-0 bg-[#faf8f3]/80 backdrop-blur-sm flex items-center justify-center p-4 z-30">
          <div className="w-full max-w-md tangle-glass-strong rounded-3xl shadow-xl p-5 border border-white/60 max-h-[90vh] overflow-y-auto">
            <div className="text-sm font-semibold text-[#2d2d2d] mb-2">Your device profile</div>
            <input type="text" value={profileNameInput} onChange={(event) => setProfileNameInput(event.target.value)} placeholder="Your name or initials" className="w-full px-3 py-2.5 rounded-2xl border border-white/70 bg-white/60 outline-none mb-3 text-sm" />
            <div className="flex gap-2 mb-3 flex-wrap">
              {PROFILE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setProfileColorInput(color)}
                  className={`w-8 h-8 rounded-full border-2 shadow-sm ${profileColorInput === color ? 'border-rose-400 ring-2 ring-rose-200' : 'border-white'}`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
            <div className="text-xs bg-white/55 rounded-2xl p-3 mb-3 border border-white/60">
              <div className="text-gray-700">Transfer code (save this to reclaim your puck on a new device):</div>
              <div className="font-semibold mt-1 tracking-wide">{profile.transferCode}</div>
            </div>
            <div className="text-xs font-semibold text-[#2d2d2d] mb-1">Reclaim with transfer code</div>
            <div className="flex gap-2 flex-col sm:flex-row">
              <input
                type="text"
                value={reclaimCodeInput}
                onChange={(event) => setReclaimCodeInput(event.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                className="flex-1 px-3 py-2 rounded-2xl border border-white/70 bg-white/60 outline-none text-sm"
              />
              <button type="button" onClick={reclaimProfile} className="px-4 py-2 rounded-full bg-white/70 border border-gray-200 text-sm font-semibold hover:bg-white shrink-0">
                Reclaim
              </button>
            </div>
            {reclaimStatus && <div className="text-xs mt-2 text-gray-700">{reclaimStatus}</div>}
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" onClick={() => setShowProfileForm(false)} className="px-4 py-2 rounded-full bg-white/70 border border-gray-200 text-sm font-semibold hover:bg-white">
                Close
              </button>
              <button type="button" onClick={saveProfile} className="px-4 py-2 rounded-full tangle-soft-btn text-sm font-semibold">
                Save profile
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-4 left-4 right-4 z-30 lg:left-6 lg:right-[calc(500px+1.5rem)]">
        <div className="tangle-glass-strong rounded-2xl p-3 shadow-lg border border-white/60 flex items-center gap-3">
          <button type="button" onClick={() => setShowBookForm(true)} className="w-11 h-11 rounded-full bg-white/80 border border-rose-100 hover:bg-white flex items-center justify-center shadow-inner shrink-0" title="Add book">
            <svg className="w-6 h-6 text-rose-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <input type="text" value={shareableLink} readOnly className="flex-1 bg-transparent outline-none text-xs sm:text-sm text-gray-700 min-w-0" />
          <button type="button" onClick={copyShareLink} className="px-3 py-2 rounded-full tangle-soft-btn text-xs sm:text-sm font-semibold shrink-0">
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
