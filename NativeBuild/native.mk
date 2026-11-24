# Genuine ia32 SDK targets. No vendor DLL, stub or recorded-response targets.
SDK_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
ELECTRON_SOURCE ?=
NATIVE_CC ?= $(if $(strip $(ELECTRON_SOURCE)),$(ELECTRON_SOURCE)/third_party/llvm-build/Release+Asserts/bin/clang,clang)
DEPS_ROOT ?=
OUTPUT ?= $(SDK_ROOT)/NativeIntegration/lib
JSON_PREFIX ?= $(SDK_ROOT)/NativeBuild/json-c
SQLITE_SOURCE ?= $(SDK_ROOT)/vendor/sqlite3mc-1.4.6
INTEGRITY_INCLUDE ?=
ifeq ($(strip $(DEPS_ROOT)),)
$(error DEPS_ROOT must name the isolated native dependency prefix)
endif
SYSROOT := $(DEPS_ROOT)/sysroot
CC := $(NATIVE_CC)
PKG_ENV := PKG_CONFIG_LIBDIR=$(SYSROOT)/usr/lib/i386-linux-gnu/pkgconfig:$(SYSROOT)/usr/share/pkgconfig PKG_CONFIG_SYSROOT_DIR=$(SYSROOT)
PKG = env $(PKG_ENV) pkg-config
OBJ := $(OUTPUT)/.objects
JSON_LIB := $(JSON_PREFIX)/lib/libjson-c.a
CPPFLAGS := -I$(SDK_ROOT) -I$(SDK_ROOT)/LoginSecurity -I$(SDK_ROOT)/MessagingFiles -I$(SDK_ROOT)/Conference -I$(SDK_ROOT)/NativeIntegration -I$(JSON_PREFIX)/include -I$(abspath $(SQLITE_SOURCE)/../..)
CFLAGS := --target=i686-linux-gnu --sysroot=$(SYSROOT) --gcc-toolchain=$(SYSROOT)/usr -std=gnu11 -O2 -fPIC -fvisibility=hidden -Wall -Wextra -pthread
LDFLAGS := --target=i686-linux-gnu --sysroot=$(SYSROOT) --gcc-toolchain=$(SYSROOT)/usr -shared -pthread -Wl,-z,defs -Wl,--exclude-libs,ALL -Wl,-rpath,'$$ORIGIN/runtime'
TARGETS := common_utils.dll.so conference_db.dll.so http_with_rs.dll.so sqlite_plugin.dll.so contact_sqlite_plugin.dll.so wk_login.dll.so wk_security.dll.so wk_tup_support.dll.so meeting_adapter.dll.so tup_im_logic_api.so tup_offlinefile_logic_api.so tup_nativetools_logic_api.so tup_sqlite_logic_api.so db_import_export_tools.so welink-import-export-worker welink-voice-worker
TARGETS += welink-render-surface-worker
objects = $(addprefix $(OBJ)/,$(1:.c=.o))
COMMON_DB := native_storage.c kmc_compat.c
IDENTITY := LoginSecurity/login_security_identity.c
HTTP := LoginSecurity/login_security_http.c
CODEC := $(OUTPUT)/.sqlite3mc.o

.PHONY: all native-only $(TARGETS)
all: $(TARGETS)
# The integrity checker is built only after assemble_app.py prepare emits its header.
native-only: $(filter-out sqlite_plugin.dll.so,$(TARGETS))
$(TARGETS): %: $(OUTPUT)/%

$(OBJ)/%.o: $(SDK_ROOT)/%.c
	@mkdir -p $(@D)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(EXTRA_CFLAGS) -MMD -MP -c $< -o $@

$(CODEC): $(SQLITE_SOURCE)/sqlite3mc_amalgamation.c $(SDK_ROOT)/native_codec_target.h
	@mkdir -p $(@D)
	$(CC) $(CPPFLAGS) $(CFLAGS) -DCODEC_TYPE=2 -msse2 -include $(SDK_ROOT)/native_codec_target.h -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_DEFAULT_AUTOVACUUM=1 -DSQLITE_DEFAULT_RECURSIVE_TRIGGERS=1 '-DSQLITE_API=__attribute__((visibility("hidden")))' -c $< -o $@

$(JSON_LIB):
	$(error Build JSON-C first: python3 NativeBuild/bootstrap.py --help; or set JSON_PREFIX)

$(OUTPUT)/runtime:
	@mkdir -p $(OUTPUT)
	ln -s $(DEPS_ROOT)/runtime $@

$(OUTPUT)/common_utils.dll.so: $(call objects,common_utils.c common_db.c $(COMMON_DB) $(IDENTITY)) $(CODEC) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs openssl) -lm -ldl

$(OUTPUT)/conference_db.dll.so: $(call objects,Conference/conference_db.c $(COMMON_DB)) $(CODEC) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs openssl) -lm -ldl

$(OUTPUT)/http_with_rs.dll.so: $(call objects,HttpBridge/http_with_rs.c $(HTTP)) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs libcurl openssl) -ldl

$(OUTPUT)/sqlite_plugin.dll.so: $(call objects,tup_sqlite.c $(COMMON_DB) $(IDENTITY) LoginSecurity/pedestal_integrity.c) $(CODEC) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs openssl) -lm -ldl
$(OBJ)/LoginSecurity/pedestal_integrity.o: CPPFLAGS += -DPEDESTAL_NATIVE_INTEGRITY -I$(INTEGRITY_INCLUDE)
$(OBJ)/LoginSecurity/pedestal_integrity.o: $(OBJ)/LoginSecurity/pedestal_integrity.baseline

# Prepared headers carry SOURCE_DATE_EPOCH, so their mtime cannot identify a
# new baseline. Track both content and include path without rebuilding unchanged inputs.
.PHONY: force-integrity-baseline
$(OBJ)/LoginSecurity/pedestal_integrity.baseline: force-integrity-baseline $(INTEGRITY_INCLUDE)/native_integrity_manifest.h
	@mkdir -p $(@D)
	@sha256sum "$(INTEGRITY_INCLUDE)/native_integrity_manifest.h" > "$@.tmp"
	@if cmp -s "$@.tmp" "$@"; then rm "$@.tmp"; else mv "$@.tmp" "$@"; fi

$(OUTPUT)/contact_sqlite_plugin.dll.so: $(call objects,Contact/contact_sqlite_plugin.c $(COMMON_DB)) $(CODEC) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs glib-2.0 libcrypto) -lm -ldl
$(OBJ)/Contact/contact_sqlite_plugin.o: EXTRA_CFLAGS += $(shell $(PKG) --cflags glib-2.0)

$(OUTPUT)/wk_login.dll.so: $(call objects,LoginSecurity/wk_login.c $(HTTP) $(IDENTITY)) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs libcurl openssl) -ldl

$(OUTPUT)/wk_security.dll.so: $(call objects,LoginSecurity/wk_security.c) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs openssl) -ldl

$(OUTPUT)/wk_tup_support.dll.so: $(call objects,Support/wk_tup_support.c $(COMMON_DB)) $(CODEC) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -Wl,--wrap=json_object_new_string -Wl,--wrap=json_object_new_string_len -o $@ $^ $$($(PKG) --libs openssl) -lm -ldl

$(OUTPUT)/db_import_export_tools.so: $(call objects,ImportExport/db_import_export_tools.c) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs libcrypto) -ldl

$(OUTPUT)/welink-import-export-worker: $(call objects,ImportExport/ie_worker.c ImportExport/ie_files.c ImportExport/ie_database.c ImportExport/ie_render.c $(COMMON_DB)) $(CODEC) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(filter-out -shared,$(LDFLAGS)) -o $@ $^ $$($(PKG) --libs glib-2.0 libarchive libcrypto zlib) -lm -ldl
$(call objects,ImportExport/ie_worker.c ImportExport/ie_files.c ImportExport/ie_database.c ImportExport/ie_render.c): EXTRA_CFLAGS += $(shell $(PKG) --cflags glib-2.0 libarchive)

# Original-model numerical PNR worker. Public operations fail closed while the
# original upstream spectral/quality and media-control producers are unavailable.
VOICE_SOURCES := $(addprefix Conference/,meeting_voice_worker.c meeting_voice_engine.c meeting_voice_engine_outer.c meeting_voice_gate.c meeting_voice_projection.c meeting_voice_temporal.c meeting_voice_bottleneck.c meeting_voice_upsample.c meeting_voice_synthesis.c meeting_voice_adaptive.c meeting_voice_cluster_fields.c meeting_voice_cluster_encoder.c meeting_voice_cluster_backbone.c meeting_voice_cluster_head.c meeting_voice_frontend.c meeting_voice_quant.c meeting_voice_pool.c)
$(call objects,$(VOICE_SOURCES)): EXTRA_CFLAGS += -msse2 -mfpmath=sse -fno-fast-math -ffp-contract=off $(shell $(PKG) --cflags libcrypto)
$(OUTPUT)/welink-render-surface-worker: $(call objects,Conference/meeting_render_surface_worker.c) | $(OUTPUT)/runtime
	$(CC) $(filter-out -shared,$(LDFLAGS)) -o $@ $^ $$($(PKG) --libs xcb xcb-composite xcb-shape)

$(OUTPUT)/welink-voice-worker: $(call objects,$(VOICE_SOURCES)) | $(OUTPUT)/runtime
	$(CC) $(filter-out -shared,$(LDFLAGS)) -o $@ $^ $$($(PKG) --libs libcrypto) -lm

$(OUTPUT)/meeting_adapter.dll.so: $(call objects,Conference/meeting_adapter.c Conference/meeting_native_token.c NativeIntegration/meeting_native_identity.c $(IDENTITY)) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs libcurl openssl) -ldl

$(OUTPUT)/tup_im_logic_api.so: $(call objects,MessagingFiles/tup_im.c MessagingFiles/im_transport_codec.c MessagingFiles/im_transport_presence.c MessagingFiles/im_transport_adapter.c $(HTTP)) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs gio-2.0 libcurl openssl xcb xcb-screensaver) -ldl

$(OUTPUT)/tup_offlinefile_logic_api.so: $(call objects,MessagingFiles/tup_offlinefile.c $(HTTP)) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs gio-2.0 libcurl openssl) -ldl

$(OUTPUT)/tup_nativetools_logic_api.so: $(call objects,MessagingFiles/tup_nativetools.c) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs gio-2.0 gdk-pixbuf-2.0 libarchive) -lgif -lm -ldl

$(OUTPUT)/tup_sqlite_logic_api.so: $(call objects,MessagingFiles/im_sqlite.c MessagingFiles/im_transport_db_entities.c MessagingFiles/im_transport_db_history.c $(COMMON_DB)) $(CODEC) $(JSON_LIB) | $(OUTPUT)/runtime
	$(CC) $(LDFLAGS) -o $@ $^ $$($(PKG) --libs gio-2.0 openssl) -lm -ldl

$(call objects,MessagingFiles/tup_im.c MessagingFiles/im_transport_codec.c MessagingFiles/im_transport_adapter.c MessagingFiles/tup_offlinefile.c MessagingFiles/im_sqlite.c MessagingFiles/im_transport_db_entities.c MessagingFiles/im_transport_db_history.c): EXTRA_CFLAGS += $(shell $(PKG) --cflags gio-2.0)
$(OBJ)/MessagingFiles/tup_nativetools.o: EXTRA_CFLAGS += $(shell $(PKG) --cflags gio-2.0 gdk-pixbuf-2.0 libarchive)
$(OBJ)/MessagingFiles/im_transport_presence.o: EXTRA_CFLAGS += $(shell $(PKG) --cflags gio-2.0 xcb-screensaver)

-include $(wildcard $(OBJ)/*.d $(OBJ)/*/*.d)
