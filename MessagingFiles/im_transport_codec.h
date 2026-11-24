/* Private, schema-driven ECS/NBR codec. Schema data comes from the hash-matched
 * vendor's generated constructors and CollectMetaStream, not the bus payloads. */
#ifndef WELINK_IM_TRANSPORT_CODEC_H
#define WELINK_IM_TRANSPORT_CODEC_H
#include <stddef.h>
#include <stdint.h>
#include <glib.h>
#include <json-c/json.h>

/* Native wire code, not the JS command/notification namespace. */
const char *im_nbr_message_name(uint16_t code);
int im_nbr_encode(uint16_t code, struct json_object *value, GByteArray *output);
struct json_object *im_nbr_decode(uint16_t code, const void *data, size_t size, int *error);

struct im_nbr_packet {
    uint16_t version;
    uint16_t code;
    uint16_t serial;
    uint8_t type;
    uint8_t flags;
    uint64_t session_id;
    const unsigned char *extension;
    size_t extension_size;
    const unsigned char *body;
    size_t body_size;
};
/* Overlay only metadata actually supplied by the peer. A legacy frame or
 * empty extension leaves the message body unchanged. */
int im_nbr_apply_metadata(const struct im_nbr_packet *packet, struct json_object *message);
/* Complete TLS-stream frame: big-endian u32 length followed by PacketMobile.
 * An empty payload is the transport heartbeat. Parsed pointers borrow data. */
int im_nbr_frame(const struct im_nbr_packet *packet, GByteArray *output);
/* Encode directly into the requested header layout without copying the body. */
int im_nbr_message_frame(uint16_t version, uint16_t code, uint16_t serial, uint64_t session_id,
                         struct json_object *value, GByteArray *output);
int im_nbr_packet_parse(const void *payload, size_t size, struct im_nbr_packet *packet);
#endif
