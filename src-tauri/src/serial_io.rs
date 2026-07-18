//! UTF-8 boundary-safe decoding for streamed serial bytes.
//!
//! Serial `read()` may split a multi-byte UTF-8 character across two reads
//! (a Chinese character is 3 bytes). Naively decoding each chunk with
//! `String::from_utf8_lossy` would corrupt those characters. We accumulate
//! bytes in a buffer and only decode up to the last complete character boundary,
//! carrying the tail forward to the next read.

/// Given a byte buffer that ends mid-character, return the index of the last
/// complete UTF-8 character's boundary (i.e. a slice `&buf[..idx]` is valid UTF-8).
///
/// A UTF-8 leading byte's high bits encode the character's total byte length:
///   0xxxxxxx            -> 1 byte   (ASCII)
///   110xxxxx 10xxxxxx   -> 2 bytes
///   1110xxxx 10.. 10..  -> 3 bytes  (most CJK characters, including 中文)
///   11110xxx 10.. ×3    -> 4 bytes  (emoji, etc.)
///
/// We inspect the last 1–3 bytes; if they form an incomplete prefix we trim back.
pub fn utf8_safe_boundary(buf: &[u8]) -> usize {
    let len = buf.len();
    if len == 0 {
        return 0;
    }
    // Walk back at most 3 bytes from the end.
    let look_back = len.min(3);
    for i in 1..=look_back {
        let idx = len - i;
        let lead = buf[idx];
        if lead < 0x80 {
            // ASCII byte — character complete at idx inclusive.
            return len;
        }
        if (0xC0..=0xDF).contains(&lead) {
            // 2-byte leader; needs 1 more continuation byte after it.
            return if len - idx >= 2 { len } else { idx };
        }
        if (0xE0..=0xEF).contains(&lead) {
            // 3-byte leader (common for Chinese); needs 2 more bytes.
            return if len - idx >= 3 { len } else { idx };
        }
        if (0xF0..=0xF7).contains(&lead) {
            // 4-byte leader (emoji); needs 3 more bytes.
            return if len - idx >= 4 { len } else { idx };
        }
        // 0x80-0xBF is a continuation byte; keep scanning backwards.
    }
    // No leading byte found in the last 3 bytes — all are continuation bytes,
    // meaning the leader arrived in a previous read (shouldn't happen if we
    // carried the tail correctly, but be safe).
    len - look_back
}

/// Decode a buffered slice up to its safe UTF-8 boundary.
/// The returned `String` contains only complete characters.
pub fn decode_chunk(buf: &[u8]) -> String {
    let safe = utf8_safe_boundary(buf);
    String::from_utf8_lossy(&buf[..safe]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_unchanged() {
        assert_eq!(decode_chunk(b"hello"), "hello");
    }

    #[test]
    fn complete_chinese_decoded() {
        // "中" is E4 B8 AD (3 bytes)
        let bytes = "中文".as_bytes();
        assert_eq!(decode_chunk(bytes), "中文");
        assert_eq!(utf8_safe_boundary(bytes), bytes.len());
    }

    #[test]
    fn split_chinese_carries_tail() {
        // Buffer: 'A' (complete) + 0xE4 (incomplete leader of "中").
        // The decoder should keep only the 'A' and carry 0xE4 forward.
        let first_chunk: &[u8] = &[0x41, 0xE4];
        let boundary = utf8_safe_boundary(first_chunk);
        assert_eq!(boundary, 1, "boundary should stop before the lone 0xE4");
        assert_eq!(&first_chunk[..boundary], &[0x41]);
    }

    #[test]
    fn split_chinese_resumes_correctly() {
        // Simulate two reads that together form "中文".
        let full = "中文".as_bytes(); // 6 bytes: E4 B8 AD E6 96 87
        let read1 = &full[..2]; // E4 B8 — incomplete first char
        let read2 = &full[2..]; // AD E6 96 87

        // Read 1: nothing decodable (boundary 0).
        let b1 = utf8_safe_boundary(read1);
        assert_eq!(b1, 0);
        let leftover_after_1 = read1[b1..].to_vec();

        // Read 2: prepend leftover.
        let mut combined = leftover_after_1;
        combined.extend_from_slice(read2);
        let decoded = decode_chunk(&combined);
        assert_eq!(decoded, "中文");
    }

    #[test]
    fn empty_buffer_safe() {
        assert_eq!(utf8_safe_boundary(&[]), 0);
        assert_eq!(decode_chunk(&[]), "");
    }

    #[test]
    fn mixed_ascii_and_chinese() {
        let bytes = "OK 测试 done".as_bytes();
        assert_eq!(decode_chunk(bytes), "OK 测试 done");
    }
}
