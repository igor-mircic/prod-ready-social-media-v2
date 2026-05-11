package com.prodready.social.posts;

import java.nio.ByteBuffer;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.UUID;
import org.springframework.stereotype.Component;

@Component
class PostCursorCodec {

  static final byte VERSION = 0x01;
  static final int ENCODED_LENGTH = 1 + 8 + 16;

  record DecodedCursor(OffsetDateTime createdAt, UUID id) {}

  String encode(OffsetDateTime createdAt, UUID id) {
    ByteBuffer buf = ByteBuffer.allocate(ENCODED_LENGTH);
    buf.put(VERSION);
    buf.putLong(createdAt.toInstant().toEpochMilli());
    buf.putLong(id.getMostSignificantBits());
    buf.putLong(id.getLeastSignificantBits());
    return Base64.getUrlEncoder().withoutPadding().encodeToString(buf.array());
  }

  DecodedCursor decode(String cursor) {
    if (cursor == null || cursor.isEmpty()) {
      throw new InvalidCursorException();
    }
    byte[] raw;
    try {
      raw = Base64.getUrlDecoder().decode(cursor);
    } catch (IllegalArgumentException ex) {
      throw new InvalidCursorException();
    }
    if (raw.length != ENCODED_LENGTH) {
      throw new InvalidCursorException();
    }
    ByteBuffer buf = ByteBuffer.wrap(raw);
    byte version = buf.get();
    if (version != VERSION) {
      throw new InvalidCursorException();
    }
    long millis = buf.getLong();
    long high = buf.getLong();
    long low = buf.getLong();
    OffsetDateTime createdAt =
        OffsetDateTime.ofInstant(Instant.ofEpochMilli(millis), ZoneOffset.UTC);
    UUID id = new UUID(high, low);
    return new DecodedCursor(createdAt, id);
  }
}
