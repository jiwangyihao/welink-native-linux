/* Native history slice. Protocol/schema recovered from im_sqlite_plugin and im_ecsdata.
 * Keep the on-disk names and mixed-case JSON keys: existing Windows profiles use them.
 * Database handles and encryption are exclusively owned by the service core. */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#include "im_transport_db.h"
#include <ctype.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <glib/gstdio.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct json_object J;

/* No history operation may run while the archive journal can replay a reset. */
static int h_history_ready(struct im_db_context *ctx);

static size_t h_length(J *value)
{
    return json_object_is_type(value, json_type_array) ? json_object_array_length(value) : 0;
}

struct history_field {
    const char *column, *key, *declaration;
    int string_value, initial;
};
struct history_table {
    const char *name, *database;
    const struct history_field *fields;
    size_t count;
};
#define HCOUNT(a) (sizeof(a) / sizeof((a)[0]))

static const struct history_field fields_0[] = {
    {"AUTOID", "id", "INTEGER PRIMARY KEY AUTOINCREMENT", 0, 0},
    {"CONVERSATION_TYPE", "convtype", "INTEGER", 0, -1},
    {"ACCOUNT", "account", "VARCHAR(32)", 1, 0},
    {"CONTACTAUTOID", "contactautoid", "INTEGER", 0, -1},
    {"GROUPID", "groupid", "VARCHAR(32)", 1, 0},
    {"LAST_MESSAGE_RECORDID", "lastmessagerecordid", "INTEGER", 0, -1},
    {"UNREADMSG", "unreadmsg", "INTEGER", 0, 0},
    {"UNREADCALL", "unreadcall", "INTEGER", 0, 0},
    {"ISDELETE", "isdelete", "INTEGER", 0, -1},
    {"STICKONTOP", "stickontop", "INTEGER", 0, 0},
    {"TIMESTAMP", "timestamp", "VARCHAR(32)", 1, 0},
    {"CONTACTID", "contactid", "VARCHAR(32)", 1, 0},
    {"LASTSERVERMESSAGEID", "lastservermessageid", "VARCHAR(32)", 1, 0},
    {"CONVERSATION_ID", "convid", "VARCHAR(64)", 1, 0},
    {"EXPARAMS", "exparams", "VARCHAR(256)", 1, 0},
    {"TOPOPERATETIME", "topoperatetime", "VARCHAR(32)", 1, 0},
    {"CONTACTINFO", "contact", "VARCHAR(1200)", 1, 0},
    {"LASTMESSAGEINFO", "lastMessageInfo", "VARCHAR(64)", 1, 0},
    {"SENDERLASTMARKTIME", "senderLastMarkTime", "INTEGER", 0, 0},
    {"RECEIVERLASTMARKTIME", "receiverLastMarkTime", "INTEGER", 0, 0},
    {"UNREADCOUNT", "unReadCount", "INTEGER", 0, 0},
    {"UNACCEPTCOUNT", "unAcceptCount", "INTEGER", 0, 0},
    {"SOURCE", "source", "INTEGER", 0, 0},
    {"MSGNOTDISTURB", "isSetMessageNotDisturb", "INTEGER", 0, 0},
    {"DRAFT", "draft", "VARCHAR(1600)", 1, 0},
    {"RCMSGSTATE", "rcMsgState", "INTEGER", 0, 0},
    {"AUTOTRANSLATE", "autoTranslate", "INTEGER", 0, 0},
    {"EMOJIREPLYMSGIDS", "emojiReplyMsgIds", "VARCHAR(1600)", 1, 0},
    {"EMOJIREPLYTIMESTAMP", "emojiReplyTimestamp", "INTEGER", 0, 0},
    {"INVITESYNCTIME", "inviteSyncTime", "INTEGER", 0, 0},
    {"ISVIP", "isVip", "VARCHAR(8)", 1, 0},
    {"NLEVEL", "nlevel", "INTEGER", 0, 0},
    {"APPREPLYMSGIDS", "appReplyMsgIds", "VARCHAR(1600)", 1, 0},
    {"APPREPLYTIMESTAMP", "appReplyTimestamp", "INTEGER", 0, 0},
    {"FIRSTTIMESTAMP", "firstTimestamp", "VARCHAR(32)", 1, 0},
    {"ISDELETEINHIS", "isDeleteInHis", "INTEGER DEFAULT(-1)", 0, -1},
};

static const struct history_field fields_1[] = {
    {"AUTOID", "id", "INTEGER PRIMARY KEY AUTOINCREMENT", 0, 0},
    {"CONVERSATION_ID", "convid", "VARCHAR(64)", 1, 0},
    {"CONVERSATION_AUTOID", "convautoid", "INTEGER", 0, 0},
    {"RECORDID", "recordid", "INTEGER", 0, 0},
    {"SERVERMESSAGEID", "servermessageid", "VARCHAR(32)", 1, 0},
    {"SRCSTAFFID", "staffid", "INTEGER", 0, 0},
    {"FILEHANDLE", "filehandle", "VARCHAR(256)", 1, 0},
    {"FILEDEALTYPE", "filedealtype", "INTEGER", 0, 0},
    {"FILEPATH", "filepath", "VARCHAR(256)", 1, 0},
    {"ISP2P", "isp2p", "INTEGER", 0, 0},
    {"FILENAME", "filename", "VARCHAR(256)", 1, 0},
    {"FILEREALNAME", "filerealname", "VARCHAR(256)", 1, 0},
    {"FILEREALPATH", "filerealpath", "VARCHAR(256)", 1, 0},
    {"FILESIZE", "filesize", "INTEGER", 1, 0},
    {"UMURL", "umurl", "VARCHAR(512)", 1, 0},
    {"UMACCESSCODE", "umaccesscode", "VARCHAR(64)", 1, 0},
    {"ISDOWNLOADED", "isdownloaded", "INTEGER", 0, 0},
    {"ISQUOTE", "isquote", "INTEGER", 0, 0},
    {"FILETYPE", "filetype", "INTEGER", 0, 0},
    {"EXPARAMS", "exparams", "VARCHAR(256)", 1, 0},
    {"TIMESTAMP", "timestamp", "VARCHAR(32)", 1, 0},
    {"FILEID", "fileid", "VARCHAR(64)", 1, 0},
    {"OWNERID", "ownerid", "VARCHAR(64)", 1, 0},
};

static const struct history_field fields_2[] = {
    {"AUTOID", "id", "INTEGER PRIMARY KEY AUTOINCREMENT", 0, 0},
    {"CONVERSATION_ID", "convid", "VARCHAR(64)", 1, 0},
    {"CONVERSATION_AUTOID", "convautoid", "INTEGER", 0, 0},
    {"SERVERMESSAGEID", "servermessageid", "VARCHAR(32)", 1, 0},
    {"RECORDID", "recordid", "INTEGER", 0, 0},
    {"SRCSTAFFID", "staffid", "INTEGER", 0, 0},
    {"FILEHANDLE", "filehandle", "VARCHAR(256)", 1, 0},
    {"FILEDEALTYPE", "filedealtype", "INTEGER", 0, 0},
    {"FILENAME", "filename", "VARCHAR(256)", 1, 0},
    {"FILEPATH", "filepath", "VARCHAR(256)", 1, 0},
    {"FILEREALNAME", "filerealname", "VARCHAR(256)", 1, 0},
    {"FILEREALPATH", "filerealpath", "VARCHAR(256)", 1, 0},
    {"HEIGHT", "height", "VARCHAR(16)", 1, 0},
    {"WIDTH", "width", "VARCHAR(16)", 1, 0},
    {"ISDOWNLOADED", "isdownloaded", "INTEGER", 0, -1},
    {"UMURL", "umurl", "VARCHAR(512)", 1, 0},
    {"UMACCESSCODE", "umaccesscode", "VARCHAR(64)", 1, 0},
    {"ISQUOTE", "isquote", "INTEGER", 0, 0},
    {"TIMESTAMP", "timestamp", "VARCHAR(32)", 1, 0},
    {"FILEID", "fileid", "VARCHAR(64)", 1, 0},
    {"OWNERID", "ownerid", "VARCHAR(64)", 1, 0},
    {"ORIENTATION", "orientation", "INTEGER", 0, 0},
};

static const struct history_field fields_3[] = {
    {"RECORD_ID", "recordid", "INTEGER PRIMARY KEY AUTOINCREMENT", 1, 0},
    {"CONVERSATION_ID", "convid", "VARCHAR(64)", 1, 0},
    {"CONVERSATION_AUTOID", "convautoid", "INTEGER", 0, -1},
    {"SERVERMESSAGEID", "servermessageid", "VARCHAR(32)", 1, 0},
    {"CLIENTMESSAGEID", "clientmessageid", "VARCHAR(32)", 1, 0},
    {"RECORDTYPE", "chattype", "INTEGER", 0, -1},
    {"CONTENT", "content", "VARCHAR(2500)", 1, 0},
    {"CONTENTTYPE", "contenttype", "INTEGER", 0, -1},
    {"DELIVERTIME", "delivertime", "VARCHAR(32)", 1, 0},
    {"FILELIST", "filelist", "VARCHAR(2048)", 1, 0},
    {"GROUPID", "groupid", "VARCHAR(32)", 1, 0},
    {"GROUPNAME", "groupname", "VARCHAR(64)", 1, 0},
    {"PEERNAME", "peername", "VARCHAR(64)", 1, 0},
    {"PEERNATIVENAME", "peernativename", "VARCHAR(64)", 1, 0},
    {"ORIGINACCOUNT", "originaccount", "VARCHAR(32)", 1, 0},
    {"TARGETACCOUNT", "targetaccount", "VARCHAR(32)", 1, 0},
    {"SHOWHTML", "showhtml", "VARCHAR(1600)", 1, 0},
    {"SHOWTEXT", "showtext", "VARCHAR(700)", 1, 0},
    {"MEDIATYPE", "mediatype", "INTEGER", 0, -1},
    {"ISREAD", "isread", "INTEGER", 0, -1},
    {"ISDELETE", "isdelete", "INTEGER", 0, -1},
    {"SOURCEFLAG", "sourceflag", "INTEGER", 0, -1},
    {"QUOTE", "quote", "VARCHAR(512)", 1, 0},
    {"TIMESTAMP", "timestamp", "VARCHAR(32)", 1, 0},
    {"UTCSTAMP", "utcstamp", "VARCHAR(32)", 1, 0},
    {"STATUS", "status", "INTEGER", 0, -1},
    {"SUBMSGTYPE", "submsgtype", "INTEGER", 0, 0},
    {"SHOWTRANSLATE", "showtranslate", "VARCHAR(1600)", 1, 0},
    {"PROVIDERCN", "providerCn", "VARCHAR(64)", 1, 0},
    {"PROVIDEREN", "providerEn", "VARCHAR(64)", 1, 0},
    {"COMBINEMESSAGEFILELIST", "combineMessageFileList", "VARCHAR(1600)", 1, 0},
    {"RECEIPTSTATE", "receiptState", "INTEGER", 0, 0},
    {"RECEIPTCOUNT", "receiptCount", "INTEGER", 0, 0},
    {"ISWITHDRAW", "iswithdraw", "INTEGER", 0, 0},
    {"DURATION", "duration", "INTEGER", 0, 0},
    {"SOURCE", "source", "INTEGER", 0, 0},
    {"FILE_SIZE", "fileSize", "INTEGER", 0, 0},
    {"EXTRA", "extra", "VARCHAR(1600)", 1, 0},
    {"ATTACH_URL", "attachUrl", "VARCHAR(1600)", 1, 0},
    {"ISAPPMSG", "isAppMsg", "INTEGER", 0, -1},
    {"APPSERVICEID", "appServiceId", "VARCHAR(64)", 1, 0},
    {"APPSERVICENAME", "appServiceName", "VARCHAR(64)", 1, 0},
    {"ISSHOWTRANSLATE", "isShowTranslate", "INTEGER", 0, 0},
    {"TRANSLATELANG", "translateLang", "VARCHAR(32)", 1, 0},
    {"EMOJIREPLYINFOS", "emojiReplyInfos", "VARCHAR(2500)", 1, 0},
    {"APPREPLYINFOS", "appReplyInfos", "VARCHAR(2500)", 1, 0},
    {"CHATATINFO", "chatAtInfo", "VARCHAR(1000)", 1, 0},
    {"UTCDATE", "utcdate", "DATE", 1, 0},
    {"ISSHOWAUDIOTEXT", "isShowAudioText", "INTEGER", 0, 0},
    {"AUDIOTEXT", "audioText", "VARCHAR(1600)", 1, 0},
};

static const struct history_field fields_4[] = {
    {"RECORD_ID", "recordid", "INTEGER PRIMARY KEY AUTOINCREMENT", 0, 0},
    {"CONVERSATION_ID", "convid", "VARCHAR(64)", 1, 0},
    {"ACCOUNT", "originaccount", "VARCHAR(32)", 1, 0},
    {"PEERNAME", "peername", "VARCHAR(64)", 1, 0},
    {"PEERNATIVENAME", "peernativename", "VARCHAR(64)", 1, 0},
    {"PINYIN", "pinyin", "VARCHAR(64)", 1, 0},
    {"COMBINATION", "combination", "VARCHAR(192)", 1, 0},
};

static const struct history_field fields_5[] = {
    {"AUTOID", "id", "INTEGER PRIMARY KEY AUTOINCREMENT", 0, 0},
    {"CONTENT", "content", "VARCHAR(2048)", 1, 0},
    {"RETRYCOUNT", "retrycount", "INTEGER", 0, 0},
};

static const struct history_field fields_6[] = {
    {"AUTOID", "id", "INTEGER PRIMARY KEY AUTOINCREMENT", 0, 0},
    {"PEERACCOUNT", "peeraccount", "VARCHAR(64)", 1, 0},
    {"ISCALLOUT", "iscallout", "INTEGER", 0, -1},
    {"CALLERNUMBER", "callernumber", "VARCHAR(32)", 1, 0},
    {"CALLEENUMBER", "calleenumber", "VARCHAR(32)", 1, 0},
    {"CALLSTATE", "callstate", "INTEGER", 0, -1},
    {"CALLTYPE", "calltype", "INTEGER", 0, -1},
    {"CONFID", "confid", "VARCHAR(32)", 1, 0},
    {"CONFPASSCODE", "confpasscode", "VARCHAR(64)", 1, 0},
    {"CONFMEMBERS", "confmembers", "VARCHAR(1024)", 1, 0},
    {"GROUPID", "groupid", "VARCHAR(64)", 1, 0},
    {"STARTTIME", "starttime", "INTEGER", 0, 0},
    {"EXPARAMS", "exparams", "VARCHAR(256)", 1, 0},
    {"DURATION", "duration", "INTEGER", 0, 0},
};

static const struct history_field fields_7[] = {
    {"AUTOID", "autoId", "INTEGER PRIMARY KEY AUTOINCREMENT", 0, 0},
    {"CONVERSATION_GROUP_ID", "conversationGroupId", "VARCHAR(32)", 1, 0},
    {"CN_NAME", "cnName", "VARCHAR(64)", 1, 0},
    {"EN_NAME", "enName", "VARCHAR(64)", 1, 0},
    {"TYPE", "type", "INTEGER", 0, 0},
    {"IDX_NO", "idxNo", "INTEGER", 0, 0},
    {"CREATE_TIME", "createTime", "VARCHAR(32)", 1, 0},
    {"MODIFY_TIME", "modifyTime", "VARCHAR(32)", 1, 0},
};

static const struct history_field fields_8[] = {
    {"AUTOID", "autoId", "INTEGER PRIMARY KEY AUTOINCREMENT", 0, 0},
    {"CONVERSATION_GROUP_ID", "conversationGroupId", "VARCHAR(32)", 1, 0},
    {"CONVERSATION_ID", "conversationId", "VARCHAR(64)", 1, 0},
    {"CONVERSATION_TYPE", "conversationType", "INTEGER", 0, 0},
    {"OPT_TIME", "optTime", "VARCHAR(32)", 1, 0},
};

static const struct history_field fields_9[] = {
    {"RECORD_ID", "recordid", "INTEGER PRIMARY KEY AUTOINCREMENT", 1, 0},
    {"CONVERSATION_ID", "convid", "VARCHAR(64)", 1, 0},
    {"CONVERSATION_AUTOID", "convautoid", "INTEGER", 0, -1},
    {"SERVERMESSAGEID", "servermessageid", "VARCHAR(32)", 1, 0},
    {"CLIENTMESSAGEID", "clientmessageid", "VARCHAR(32)", 1, 0},
    {"RECORDTYPE", "chattype", "INTEGER", 0, -1},
    {"CONTENT", "content", "VARCHAR(2500)", 1, 0},
    {"CONTENTTYPE", "contenttype", "INTEGER", 0, -1},
    {"DELIVERTIME", "delivertime", "VARCHAR(32)", 1, 0},
    {"FILELIST", "filelist", "VARCHAR(2048)", 1, 0},
    {"GROUPID", "groupid", "VARCHAR(32)", 1, 0},
    {"GROUPNAME", "groupname", "VARCHAR(64)", 1, 0},
    {"PEERNAME", "peername", "VARCHAR(64)", 1, 0},
    {"PEERNATIVENAME", "peernativename", "VARCHAR(64)", 1, 0},
    {"ORIGINACCOUNT", "originaccount", "VARCHAR(32)", 1, 0},
    {"TARGETACCOUNT", "targetaccount", "VARCHAR(32)", 1, 0},
    {"SHOWHTML", "showhtml", "VARCHAR(1600)", 1, 0},
    {"SHOWTEXT", "showtext", "VARCHAR(700)", 1, 0},
    {"MEDIATYPE", "mediatype", "INTEGER", 0, -1},
    {"ISREAD", "isread", "INTEGER", 0, -1},
    {"ISDELETE", "isdelete", "INTEGER", 0, -1},
    {"SOURCEFLAG", "sourceflag", "INTEGER", 0, -1},
    {"QUOTE", "quote", "VARCHAR(512)", 1, 0},
    {"TIMESTAMP", "timestamp", "VARCHAR(32)", 1, 0},
    {"UTCSTAMP", "utcstamp", "VARCHAR(32)", 1, 0},
    {"STATUS", "status", "INTEGER", 0, -1},
    {"SUBMSGTYPE", "submsgtype", "INTEGER", 0, 0},
    {"SHOWTRANSLATE", "showtranslate", "VARCHAR(1600)", 1, 0},
    {"PROVIDERCN", "providerCn", "VARCHAR(64)", 1, 0},
    {"PROVIDEREN", "providerEn", "VARCHAR(64)", 1, 0},
    {"COMBINEMESSAGEFILELIST", "combineMessageFileList", "VARCHAR(1600)", 1, 0},
    {"RECEIPTSTATE", "receiptState", "INTEGER", 0, 0},
    {"RECEIPTCOUNT", "receiptCount", "INTEGER", 0, 0},
    {"ISWITHDRAW", "iswithdraw", "INTEGER", 0, 0},
    {"DURATION", "duration", "INTEGER", 0, 0},
    {"SOURCE", "source", "INTEGER", 0, 0},
    {"FILE_SIZE", "fileSize", "INTEGER", 0, 0},
    {"EXTRA", "extra", "VARCHAR(1600)", 1, 0},
    {"ATTACH_URL", "attachUrl", "VARCHAR(1600)", 1, 0},
    {"ISAPPMSG", "isAppMsg", "INTEGER", 0, -1},
    {"APPSERVICEID", "appServiceId", "VARCHAR(64)", 1, 0},
    {"APPSERVICENAME", "appServiceName", "VARCHAR(64)", 1, 0},
    {"ISSHOWTRANSLATE", "isShowTranslate", "INTEGER", 0, 0},
    {"TRANSLATELANG", "translateLang", "VARCHAR(32)", 1, 0},
    {"EMOJIREPLYINFOS", "emojiReplyInfos", "VARCHAR(2500)", 1, 0},
    {"APPREPLYINFOS", "appReplyInfos", "VARCHAR(2500)", 1, 0},
    {"CHATATINFO", "chatAtInfo", "VARCHAR(1000)", 1, 0},
};

static const struct history_field fields_10[] = {
    {"RECORD_ID", "recordid", "INTEGER PRIMARY KEY AUTOINCREMENT", 1, 0},
    {"CONVERSATION_ID", "convid", "VARCHAR(64)", 1, 0},
    {"CONVERSATION_AUTOID", "convautoid", "INTEGER", 0, -1},
    {"SERVERMESSAGEID", "servermessageid", "VARCHAR(32)", 1, 0},
    {"CLIENTMESSAGEID", "clientmessageid", "VARCHAR(32)", 1, 0},
    {"RECORDTYPE", "chattype", "INTEGER", 0, -1},
    {"CONTENT", "content", "VARCHAR(2500)", 1, 0},
    {"CONTENTTYPE", "contenttype", "INTEGER", 0, -1},
    {"DELIVERTIME", "delivertime", "VARCHAR(32)", 1, 0},
    {"FILELIST", "filelist", "VARCHAR(2048)", 1, 0},
    {"GROUPID", "groupid", "VARCHAR(32)", 1, 0},
    {"GROUPNAME", "groupname", "VARCHAR(64)", 1, 0},
    {"PEERNAME", "peername", "VARCHAR(64)", 1, 0},
    {"PEERNATIVENAME", "peernativename", "VARCHAR(64)", 1, 0},
    {"ORIGINACCOUNT", "originaccount", "VARCHAR(32)", 1, 0},
    {"TARGETACCOUNT", "targetaccount", "VARCHAR(32)", 1, 0},
    {"SHOWHTML", "showhtml", "VARCHAR(1600)", 1, 0},
    {"SHOWTEXT", "showtext", "VARCHAR(700)", 1, 0},
    {"MEDIATYPE", "mediatype", "INTEGER", 0, -1},
    {"ISREAD", "isread", "INTEGER", 0, -1},
    {"ISDELETE", "isdelete", "INTEGER", 0, -1},
    {"SOURCEFLAG", "sourceflag", "INTEGER", 0, -1},
    {"QUOTE", "quote", "VARCHAR(512)", 1, 0},
    {"TIMESTAMP", "timestamp", "VARCHAR(32)", 1, 0},
    {"UTCSTAMP", "utcstamp", "VARCHAR(32)", 1, 0},
    {"STATUS", "status", "INTEGER", 0, -1},
    {"SUBMSGTYPE", "submsgtype", "INTEGER", 0, 0},
    {"SHOWTRANSLATE", "showtranslate", "VARCHAR(1600)", 1, 0},
    {"PROVIDERCN", "providerCn", "VARCHAR(64)", 1, 0},
    {"PROVIDEREN", "providerEn", "VARCHAR(64)", 1, 0},
    {"COMBINEMESSAGEFILELIST", "combineMessageFileList", "VARCHAR(1600)", 1, 0},
    {"RECEIPTSTATE", "receiptState", "INTEGER", 0, 0},
    {"RECEIPTCOUNT", "receiptCount", "INTEGER", 0, 0},
    {"ISWITHDRAW", "iswithdraw", "INTEGER", 0, 0},
    {"DURATION", "duration", "INTEGER", 0, 0},
    {"SOURCE", "source", "INTEGER", 0, 0},
    {"FILE_SIZE", "fileSize", "INTEGER", 0, 0},
    {"EXTRA", "extra", "VARCHAR(1600)", 1, 0},
    {"ATTACH_URL", "attachUrl", "VARCHAR(1600)", 1, 0},
    {"ISAPPMSG", "isAppMsg", "INTEGER", 0, -1},
    {"APPSERVICEID", "appServiceId", "VARCHAR(64)", 1, 0},
    {"APPSERVICENAME", "appServiceName", "VARCHAR(64)", 1, 0},
    {"ISSHOWTRANSLATE", "isShowTranslate", "INTEGER", 0, 0},
    {"TRANSLATELANG", "translateLang", "VARCHAR(32)", 1, 0},
    {"EMOJIREPLYINFOS", "emojiReplyInfos", "VARCHAR(2500)", 1, 0},
    {"APPREPLYINFOS", "appReplyInfos", "VARCHAR(2500)", 1, 0},
    {"CHATATINFO", "chatAtInfo", "VARCHAR(1000)", 1, 0},
};

static const struct history_field fields_11[] = {
    {"RECORD_ID", "recordid", "INTEGER PRIMARY KEY AUTOINCREMENT", 1, 0},
    {"CONVERSATION_ID", "convid", "VARCHAR(64)", 1, 0},
    {"CONVERSATION_AUTOID", "convautoid", "INTEGER", 0, -1},
    {"SERVERMESSAGEID", "servermessageid", "VARCHAR(32)", 1, 0},
    {"CLIENTMESSAGEID", "clientmessageid", "VARCHAR(32)", 1, 0},
    {"RECORDTYPE", "chattype", "INTEGER", 0, -1},
    {"CONTENT", "content", "VARCHAR(2500)", 1, 0},
    {"CONTENTTYPE", "contenttype", "INTEGER", 0, -1},
    {"DELIVERTIME", "delivertime", "VARCHAR(32)", 1, 0},
    {"FILELIST", "filelist", "VARCHAR(2048)", 1, 0},
    {"GROUPID", "groupid", "VARCHAR(32)", 1, 0},
    {"GROUPNAME", "groupname", "VARCHAR(64)", 1, 0},
    {"PEERNAME", "peername", "VARCHAR(64)", 1, 0},
    {"PEERNATIVENAME", "peernativename", "VARCHAR(64)", 1, 0},
    {"ORIGINACCOUNT", "originaccount", "VARCHAR(32)", 1, 0},
    {"TARGETACCOUNT", "targetaccount", "VARCHAR(32)", 1, 0},
    {"SHOWHTML", "showhtml", "VARCHAR(1600)", 1, 0},
    {"SHOWTEXT", "showtext", "VARCHAR(700)", 1, 0},
    {"MEDIATYPE", "mediatype", "INTEGER", 0, -1},
    {"ISREAD", "isread", "INTEGER", 0, -1},
    {"ISDELETE", "isdelete", "INTEGER", 0, -1},
    {"SOURCEFLAG", "sourceflag", "INTEGER", 0, -1},
    {"QUOTE", "quote", "VARCHAR(512)", 1, 0},
    {"TIMESTAMP", "timestamp", "VARCHAR(32)", 1, 0},
    {"UTCSTAMP", "utcstamp", "VARCHAR(32)", 1, 0},
    {"STATUS", "status", "INTEGER", 0, -1},
    {"SUBMSGTYPE", "submsgtype", "INTEGER", 0, 0},
    {"SHOWTRANSLATE", "showtranslate", "VARCHAR(1600)", 1, 0},
    {"PROVIDERCN", "providerCn", "VARCHAR(64)", 1, 0},
    {"PROVIDEREN", "providerEn", "VARCHAR(64)", 1, 0},
    {"COMBINEMESSAGEFILELIST", "combineMessageFileList", "VARCHAR(1600)", 1, 0},
    {"RECEIPTSTATE", "receiptState", "INTEGER", 0, 0},
    {"RECEIPTCOUNT", "receiptCount", "INTEGER", 0, 0},
    {"ISWITHDRAW", "iswithdraw", "INTEGER", 0, 0},
    {"DURATION", "duration", "INTEGER", 0, 0},
    {"SOURCE", "source", "INTEGER", 0, 0},
    {"FILE_SIZE", "fileSize", "INTEGER", 0, 0},
    {"EXTRA", "extra", "VARCHAR(1600)", 1, 0},
    {"ATTACH_URL", "attachUrl", "VARCHAR(1600)", 1, 0},
    {"ISAPPMSG", "isAppMsg", "INTEGER", 0, -1},
    {"APPSERVICEID", "appServiceId", "VARCHAR(64)", 1, 0},
    {"APPSERVICENAME", "appServiceName", "VARCHAR(64)", 1, 0},
    {"ISSHOWTRANSLATE", "isShowTranslate", "INTEGER", 0, 0},
    {"TRANSLATELANG", "translateLang", "VARCHAR(32)", 1, 0},
    {"EMOJIREPLYINFOS", "emojiReplyInfos", "VARCHAR(2500)", 1, 0},
    {"APPREPLYINFOS", "appReplyInfos", "VARCHAR(2500)", 1, 0},
    {"CHATATINFO", "chatAtInfo", "VARCHAR(1000)", 1, 0},
};

static const struct history_field fields_12[] = {
    {"CONFIGURE_KEY", "configure_key", "VARCHAR(20) NOT NULL PRIMARY KEY", 1, 0},
    {"CONFIGURE_VALUE", "configure_value", "VARCHAR(20)", 1, 0},
};

enum history_table_id { H_CONVERSATION, H_FILE, H_SCREEN, H_RECORD, H_SENDER, H_TRACK, H_CALL, H_GROUP, H_MEMBER, H_OFFICIAL, H_APPLICATION, H_SPECIAL_FILE, H_CONFIGURE };
static const struct history_table tables[] = {
    {"ConversationTab", "conversationdb", fields_0, HCOUNT(fields_0)},
    {"FileRecordTab", "conversationdb", fields_1, HCOUNT(fields_1)},
    {"ScreenshotFileTab", "conversationdb", fields_2, HCOUNT(fields_2)},
    {"RecordTab", "historydb", fields_3, HCOUNT(fields_3)},
    {"SenderTab", "conversationdb", fields_4, HCOUNT(fields_4)},
    {"UserTrackTab", "sysdb", fields_5, HCOUNT(fields_5)},
    {"CALLRecordTab", "historydb", fields_6, HCOUNT(fields_6)},
    {"ConversationGroupTab", "conversationdb", fields_7, HCOUNT(fields_7)},
    {"ConversationGroupMemberTab", "conversationdb", fields_8, HCOUNT(fields_8)},
    {"OfficialAccountTab", "specialMsgdb", fields_9, HCOUNT(fields_9)},
    {"ApplicationAccountTab", "specialMsgdb", fields_10, HCOUNT(fields_10)},
    {"FileAccountTab", "specialMsgdb", fields_11, HCOUNT(fields_11)},
    {"ConfigureTab", "specialMsgdb", fields_12, HCOUNT(fields_12)},
};

/* The original fresh history.db and conversation.db share the six history
 * tables and their indexes, despite the command-specific routes above. Only
 * conversation.db adds the grouping tables. Existing profiles migrate in place. */
static const char *const conversation_indexes[] = {
    "DROP INDEX IF EXISTS CONVERSATION_UNIQUE_INDEX",
    "CREATE UNIQUE INDEX IF NOT EXISTS CONVERSATION_UNIQUE_INDEX2 ON ConversationTab(GROUPID,ACCOUNT)",
    "CREATE INDEX IF NOT EXISTS CONVERSATION_CONVID_INDEX ON ConversationTab(CONVERSATION_ID)",
    "CREATE INDEX IF NOT EXISTS CONVERSATION_GROUPID_INDEX ON ConversationTab(GROUPID)",
    "CREATE INDEX IF NOT EXISTS RECEIVERLASTMARKTIME_INDEX ON ConversationTab(RECEIVERLASTMARKTIME)",
    "DROP INDEX IF EXISTS FILE_UNIQUE_INDEX",
    "CREATE INDEX IF NOT EXISTS FILE_INDEX_CVSID ON FileRecordTab(CONVERSATION_ID)",
    "CREATE UNIQUE INDEX IF NOT EXISTS FILE_UNIQUE_INDEX_SERVERMESSAGEID ON FileRecordTab(SERVERMESSAGEID)",
    "DROP INDEX IF EXISTS SCREENSHOT_UNIQUE_INDEX",
    "DROP INDEX IF EXISTS SCREENSHOT_UNIQUE_INDEX_SERVERMESSAGEID",
    "CREATE UNIQUE INDEX IF NOT EXISTS SCREENSHOT_UNIQUE_INDEX_SERVERMESSAGEID_FILENAME ON ScreenshotFileTab(SERVERMESSAGEID,FILEREALNAME)",
    "CREATE INDEX IF NOT EXISTS SCREENSHOT_INDEX_CVSID ON ScreenshotFileTab(CONVERSATION_ID)",
    "CREATE UNIQUE INDEX IF NOT EXISTS SENDER_UNIQUE_INDEX ON SenderTab(CONVERSATION_ID,ACCOUNT)",
};
static const char *const conversation_group_indexes[] = {
    "CREATE UNIQUE INDEX IF NOT EXISTS CONVERSATION_GROUP_UNIQUE_INDEX ON ConversationGroupTab(CONVERSATION_GROUP_ID)",
    "CREATE UNIQUE INDEX IF NOT EXISTS CONVERSATION_GROUP_MEMBER_UNIQUE_INDEX ON ConversationGroupMemberTab(CONVERSATION_GROUP_ID,CONVERSATION_ID)"
};
static const char *const record_indexes[] = {
    "DROP INDEX IF EXISTS RECORD_UNIQUE_INDEX",
    "CREATE INDEX IF NOT EXISTS RECORD_INDEX_CLIENTMESSAGEID ON RecordTab(CLIENTMESSAGEID)",
    "CREATE INDEX IF NOT EXISTS RECORD_INDEX_CVSID ON RecordTab(CONVERSATION_ID)",
    "CREATE UNIQUE INDEX IF NOT EXISTS RECORD_UNIQUE_INDEX_SERVERMESSAGEID ON RecordTab(SERVERMESSAGEID)",
    "CREATE INDEX IF NOT EXISTS RECORD_INDEX_UTCSTAMP ON RecordTab(UTCSTAMP)",
    "CREATE INDEX IF NOT EXISTS RECORD_INDEX_CVSID_UTCSTAMP_SERVERMESSAGEID ON RecordTab(CONVERSATION_ID,UTCSTAMP,SERVERMESSAGEID)",
    "CREATE INDEX IF NOT EXISTS CALLRECORD_STARTTIME_INDEX ON CALLRecordTab(STARTTIME)"
};

static int h_exec(sqlite3 *db, const char *sql)
{
    return db ? sqlite3_exec(db, sql, NULL, NULL, NULL) : SQLITE_CANTOPEN;
}

static int h_schema_table(sqlite3 *db, const struct history_table *table)
{
    if (!db) return SQLITE_CANTOPEN;
    GString *sql = g_string_new("CREATE TABLE IF NOT EXISTS ");
    g_string_append_printf(sql, "%s(", table->name);
    for (size_t i = 0; i < table->count; ++i)
        g_string_append_printf(sql, "%s%s %s", i ? "," : "",
                               table->fields[i].column, table->fields[i].declaration);
    g_string_append_c(sql, ')');
    int rc = h_exec(db, sql->str);
    g_string_printf(sql, "PRAGMA table_info(%s)", table->name);
    sqlite3_stmt *stmt = NULL;
    if (rc == SQLITE_OK) rc = sqlite3_prepare_v2(db, sql->str, -1, &stmt, NULL);
    uint64_t present = 0;
    if (rc == SQLITE_OK) {
        while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
            const char *name = (const char *)sqlite3_column_text(stmt, 1);
            for (size_t i = 0; i < table->count; ++i)
                if (name && !g_ascii_strcasecmp(name, table->fields[i].column))
                    present |= UINT64_C(1) << i;
        }
        if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    sqlite3_finalize(stmt);
    for (size_t i = 0; rc == SQLITE_OK && i < table->count; ++i) {
        if (present & (UINT64_C(1) << i)) continue;
        g_string_printf(sql, "ALTER TABLE %s ADD COLUMN %s %s", table->name,
                        table->fields[i].column, table->fields[i].declaration);
        rc = h_exec(db, sql->str);
        if (rc == SQLITE_OK && !strcmp(table->fields[i].column, "ISDELETEINHIS"))
            rc = h_exec(db, "UPDATE ConversationTab SET ISDELETEINHIS=ISDELETE");
    }
    g_string_free(sql, TRUE);
    return rc;
}

static int h_history_schema(sqlite3 *db)
{
    static const enum history_table_id shared_tables[] = {
        H_RECORD, H_CONVERSATION, H_FILE, H_SCREEN, H_CALL, H_SENDER
    };
    int rc = SQLITE_OK;
    for (size_t i = 0; rc == SQLITE_OK && i < HCOUNT(shared_tables); ++i)
        rc = h_schema_table(db, &tables[shared_tables[i]]);
    for (size_t i = 0; rc == SQLITE_OK && i < HCOUNT(conversation_indexes); ++i)
        rc = h_exec(db, conversation_indexes[i]);
    for (size_t i = 0; rc == SQLITE_OK && i < HCOUNT(record_indexes); ++i)
        rc = h_exec(db, record_indexes[i]);
    return rc;
}

int im_db_history_public_schema(struct im_db_context *context)
{
    return h_schema_table(im_db_database(context, "sysdb"), &tables[H_TRACK]);
}

int im_db_history_schema(struct im_db_context *context)
{
    int rc = h_history_schema(im_db_database(context, "historydb"));
    sqlite3 *conv = im_db_database(context, "conversationdb");
    if (rc == SQLITE_OK) rc = h_history_schema(conv);
    static const enum history_table_id separate_tables[] = {
        H_GROUP, H_MEMBER, H_OFFICIAL, H_APPLICATION, H_SPECIAL_FILE, H_CONFIGURE
    };
    for (size_t i = 0; rc == SQLITE_OK && i < HCOUNT(separate_tables); ++i) {
        const struct history_table *table = &tables[separate_tables[i]];
        rc = h_schema_table(im_db_database(context, table->database), table);
    }
    for (size_t i = 0; rc == SQLITE_OK && i < HCOUNT(conversation_group_indexes); ++i)
        rc = h_exec(conv, conversation_group_indexes[i]);
    static const char *const prefixes[] = {"OFFICIAL", "APPLICATION", "FILE"};
    sqlite3 *special = im_db_database(context, "specialMsgdb");
    for (size_t i = 0; rc == SQLITE_OK && i < HCOUNT(prefixes); ++i) {
        const char *name = tables[H_OFFICIAL + i].name;
        char *sql = sqlite3_mprintf(
            "CREATE INDEX IF NOT EXISTS %s_INDEX_CLIENTMESSAGEID ON %s(CLIENTMESSAGEID);"
            "CREATE INDEX IF NOT EXISTS %s_INDEX_CVSID ON %s(CONVERSATION_ID);"
            "CREATE UNIQUE INDEX IF NOT EXISTS %s_UNIQUE_INDEX_SERVERMESSAGEID ON %s(SERVERMESSAGEID);"
            "CREATE INDEX IF NOT EXISTS %s_INDEX_UTCSTAMP ON %s(UTCSTAMP);"
            "CREATE INDEX IF NOT EXISTS %s_INDEX_CVSID_UTCSTAMP_SERVERMESSAGEID ON %s(CONVERSATION_ID,UTCSTAMP,SERVERMESSAGEID);",
            prefixes[i], name, prefixes[i], name, prefixes[i], name,
            prefixes[i], name, prefixes[i], name);
        rc = sql ? h_exec(special, sql) : SQLITE_NOMEM;
        sqlite3_free(sql);
    }
    return rc;
}

struct history_sql {
    GString *text;
    J *values;
    int error;
};

static struct history_sql h_sql(const char *text)
{
    struct history_sql sql = {g_string_new(text), json_object_new_array(), SQLITE_OK};
    if (!sql.values) sql.error = SQLITE_NOMEM;
    return sql;
}

static void h_sql_free(struct history_sql *sql)
{
    g_string_free(sql->text, TRUE);
    json_object_put(sql->values);
}

static void h_value(struct history_sql *sql, J *value)
{
    if (!value || (!json_object_is_type(value, json_type_string) &&
                   !json_object_is_type(value, json_type_int))) {
        sql->error = SQLITE_MISMATCH;
        return;
    }
    json_object_array_add(sql->values, json_object_get(value));
}

static void h_number(struct history_sql *sql, int64_t value)
{
    json_object_array_add(sql->values, json_object_new_int64(value));
}

static int h_prepare(sqlite3 *db, const struct history_sql *sql, sqlite3_stmt **stmt)
{
    *stmt = NULL;
    if (sql->error) return sql->error;
    if (!db) return SQLITE_CANTOPEN;
    int rc = sqlite3_prepare_v2(db, sql->text->str, -1, stmt, NULL);
    size_t count = json_object_array_length(sql->values);
    for (size_t i = 0; rc == SQLITE_OK && i < count; ++i) {
        J *value = json_object_array_get_idx(sql->values, i);
        if (json_object_is_type(value, json_type_int))
            rc = sqlite3_bind_int64(*stmt, (int)i + 1, json_object_get_int64(value));
        else
            rc = sqlite3_bind_text(*stmt, (int)i + 1, json_object_get_string(value),
                                   json_object_get_string_len(value), SQLITE_STATIC);
    }
    return rc;
}

static int h_run(sqlite3 *db, const struct history_sql *sql)
{
    sqlite3_stmt *stmt = NULL;
    int rc = h_prepare(db, sql, &stmt);
    if (rc == SQLITE_OK) rc = sqlite3_step(stmt);
    if (rc == SQLITE_DONE) rc = SQLITE_OK;
    int end = sqlite3_finalize(stmt);
    return rc == SQLITE_OK ? end : rc;
}

static int h_multi(J *param, J **match, int *operation)
{
    *match = native_get(param, "_multimatchinfo");
    J *data = native_get(*match, "datalist");
    J *op = native_get(*match, "operationtype");
    J *len = native_get(*match, "datalen");
    if (!json_object_is_type(*match, json_type_object) ||
        !json_object_is_type(data, json_type_array) ||
        !json_object_is_type(op, json_type_int) || !json_object_is_type(len, json_type_int) ||
        json_object_get_int64(len) < 0 ||
        (uint64_t)json_object_get_int64(len) > json_object_array_length(data))
        return SQLITE_MISMATCH;
    *operation = json_object_get_int(op);
    return SQLITE_OK;
}

static J *h_match(J *match, int key)
{
    J *data = native_get(match, "datalist");
    size_t length = (size_t)native_integer(match, "datalen", 0);
    for (size_t i = 0; i < length; ++i) {
        J *item = json_object_array_get_idx(data, i);
        if (native_integer(item, "keytype", -1) == key)
            return native_get(item, "match_value");
    }
    return NULL;
}

static const char *h_text(J *value)
{
    return json_object_is_type(value, json_type_string) ? json_object_get_string(value) : "";
}

static int64_t h_int(J *value, int64_t fallback)
{
    if (json_object_is_type(value, json_type_int)) return json_object_get_int64(value);
    if (json_object_is_type(value, json_type_string) && *json_object_get_string(value)) {
        char *end = NULL;
        errno = 0;
        int64_t result = g_ascii_strtoll(json_object_get_string(value), &end, 10);
        if (!errno && end && !*end) return result;
    }
    return fallback;
}

static void h_equal(struct history_sql *sql, const char *column, J *value)
{
    g_string_append_printf(sql->text, " AND %s=?", column);
    h_value(sql, value);
}

/* String lists in the legacy delete API are comma separated. Array match values
 * in the multi-match API are native JSON arrays, not SQL fragments. */
static void h_in(struct history_sql *sql, const char *column, J *value, int negate)
{
    J *list = value;
    int temporary = !json_object_is_type(value, json_type_array);
    if (temporary) {
        list = json_object_new_array();
        if (!json_object_is_type(value, json_type_string)) sql->error = SQLITE_MISMATCH;
        char **parts = g_strsplit(h_text(value), ",", -1);
        for (size_t i = 0; parts[i]; ++i) {
            char *part = g_strstrip(parts[i]);
            size_t n = strlen(part);
            if (n >= 2 && part[0] == '\'' && part[n - 1] == '\'') {
                part[n - 1] = 0;
                ++part;
            }
            if (*part) json_object_array_add(list, json_object_new_string(part));
        }
        g_strfreev(parts);
    }
    size_t n = json_object_array_length(list);
    if (!n) {
        g_string_append(sql->text, negate ? " AND 1=1" : " AND 0=1");
    } else {
        g_string_append_printf(sql->text, " AND %s %sIN (", column, negate ? "NOT " : "");
        for (size_t i = 0; i < n; ++i) {
            g_string_append(sql->text, i ? ",?" : "?");
            h_value(sql, json_object_array_get_idx(list, i));
        }
        g_string_append_c(sql->text, ')');
    }
    if (temporary) json_object_put(list);
}

static void h_like(struct history_sql *sql, const char *column, J *value)
{
    GString *pattern = g_string_new("%");
    for (const char *p = h_text(value); *p; ++p) {
        if (*p == '%' || *p == '_' || *p == '/') g_string_append_c(pattern, '/');
        g_string_append_c(pattern, *p);
    }
    g_string_append_c(pattern, '%');
    g_string_append_printf(sql->text, " AND %s LIKE ? ESCAPE '/'", column);
    json_object_array_add(sql->values, json_object_new_string_len(pattern->str, (int)pattern->len));
    g_string_free(pattern, TRUE);
}

static void h_limit(struct history_sql *sql, int64_t limit, int64_t offset)
{
    if (limit > 0) {
        g_string_append(sql->text, " LIMIT ?");
        h_number(sql, limit);
        if (offset > 0) {
            g_string_append(sql->text, " OFFSET ?");
            h_number(sql, offset);
        }
    }
}

static struct history_sql h_select(const struct history_table *table)
{
    struct history_sql sql = h_sql("SELECT ");
    for (size_t i = 0; i < table->count; ++i)
        g_string_append_printf(sql.text, "%s%s", i ? "," : "", table->fields[i].column);
    g_string_append_printf(sql.text, " FROM %s WHERE 1=1", table->name);
    return sql;
}

static J *h_row(sqlite3_stmt *stmt, const struct history_table *table, unsigned database_id)
{
    J *row = json_object_new_object();
    for (size_t i = 0; i < table->count; ++i) {
        const struct history_field *field = &table->fields[i];
        if (!strcmp(field->column, "UTCDATE") ||
            (table == &tables[H_FILE] && !strcmp(field->column, "FILETYPE")))
            continue;
        J *value;
        if (!i && (table == &tables[H_RECORD] ||
                   table == &tables[H_OFFICIAL] || table == &tables[H_APPLICATION] ||
                   table == &tables[H_SPECIAL_FILE])) {
            char id[64];
            snprintf(id, sizeof id, "%" PRId64 "#%u", (int64_t)sqlite3_column_int64(stmt, 0), database_id);
            value = json_object_new_string(id);
        } else if (field->string_value) {
            const char *text = (const char *)sqlite3_column_text(stmt, (int)i);
            value = json_object_new_string(text ? text : "");
        } else {
            value = json_object_new_int64(sqlite3_column_int64(stmt, (int)i));
        }
        json_object_object_add(row, field->key, value);
    }
    if (table == &tables[H_CALL]) json_object_object_add(row, "limitcount", json_object_new_int(0));
    return row;
}

static int h_query(sqlite3 *db, const struct history_sql *sql,
                   const struct history_table *table, unsigned database_id, J *rows)
{
    sqlite3_stmt *stmt = NULL;
    int rc = h_prepare(db, sql, &stmt);
    if (rc == SQLITE_OK) {
        while ((rc = sqlite3_step(stmt)) == SQLITE_ROW)
            json_object_array_add(rows, h_row(stmt, table, database_id));
        if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    sqlite3_finalize(stmt);
    return rc;
}

static J *h_list_result(const char *key, const char *length_key, J *rows)
{
    J *param = json_object_new_object();
    json_object_object_add(param, length_key, json_object_new_int64((int64_t)json_object_array_length(rows)));
    if (json_object_array_length(rows)) json_object_object_add(param, key, rows);
    else {
        json_object_put(rows);
        json_object_object_add(param, key, NULL);
    }
    return param;
}

static int h_insert_prepare(sqlite3 *db, const struct history_table *table, int ignore,
                            sqlite3_stmt **stmt)
{
    *stmt = NULL;
    if (!db) return SQLITE_CANTOPEN;
    GString *text = g_string_new(ignore ? "INSERT OR IGNORE INTO " : "INSERT OR REPLACE INTO ");
    g_string_append_printf(text, "%s(", table->name);
    for (size_t i = 0; i < table->count; ++i)
        g_string_append_printf(text, "%s%s", i ? "," : "", table->fields[i].column);
    g_string_append(text, ") VALUES(");
    for (size_t i = 0; i < table->count; ++i) g_string_append(text, i ? ",?" : "?");
    g_string_append_c(text, ')');
    int rc = sqlite3_prepare_v2(db, text->str, -1, stmt, NULL);
    g_string_free(text, TRUE);
    return rc;
}

static int h_insert_step(sqlite3_stmt *stmt, const struct history_table *table,
                         J *object, int64_t record_id, int64_t *inserted)
{
    if (!json_object_is_type(object, json_type_object)) return SQLITE_MISMATCH;
    int rc = SQLITE_OK;
    for (size_t i = 0; rc == SQLITE_OK && i < table->count; ++i) {
        const struct history_field *field = &table->fields[i];
        J *value = native_get(object, field->key);
        if (!i) {
            int64_t id = record_id >= 0 ? record_id : h_int(value, 0);
            rc = id > 0 ? sqlite3_bind_int64(stmt, 1, id) : sqlite3_bind_null(stmt, 1);
        } else if (!strcmp(field->column, "UTCDATE")) {
            rc = sqlite3_bind_null(stmt, (int)i + 1);
        } else if (field->string_value) {
            rc = sqlite3_bind_text(stmt, (int)i + 1, h_text(value), -1, SQLITE_STATIC);
        } else {
            rc = sqlite3_bind_int64(stmt, (int)i + 1, native_integer(object, field->key, field->initial));
        }
    }
    if (!rc) rc = sqlite3_step(stmt);
    if (rc == SQLITE_DONE) {
        sqlite3 *db = sqlite3_db_handle(stmt);
        if (inserted) *inserted = sqlite3_changes(db) ? sqlite3_last_insert_rowid(db) : 0;
        rc = SQLITE_OK;
    }
    int end = sqlite3_reset(stmt);
    sqlite3_clear_bindings(stmt);
    return rc ? rc : end;
}

static int h_add(struct im_db_context *ctx, enum history_table_id id, J *param,
                 const char *single_key, const char *list_key, const char *length_key,
                 int64_t *inserted)
{
    const struct history_table *table = &tables[id];
    sqlite3 *db = im_db_database(ctx, table->database);
    J *input = native_get(param, single_key ? single_key : list_key);
    int64_t count = single_key ? 1 : native_integer(param, length_key, -1);
    if (single_key ? !json_object_is_type(input, json_type_object) :
        !json_object_is_type(input, json_type_array) || count < 0 ||
        (uint64_t)count > json_object_array_length(input)) return SQLITE_MISMATCH;
    int rc = id == H_CALL ? h_history_ready(ctx) : SQLITE_OK;
    if (rc) return rc;
    rc = h_exec(db, "SAVEPOINT history_list");
    if (rc) return rc;
    sqlite3_stmt *stmt = NULL;
    rc = h_insert_prepare(db, table, 0, &stmt);
    for (int64_t i = 0; !rc && i < count; ++i) {
        J *object = single_key ? input : json_object_array_get_idx(input, (size_t)i);
        if (id == H_TRACK &&
            (strlen(native_string(object, "content", "")) > 2048 ||
             !json_object_is_type(native_get(object, "content"), json_type_string) ||
             !json_object_is_type(native_get(object, "id"), json_type_int) ||
             !json_object_is_type(native_get(object, "retrycount"), json_type_int)))
            rc = SQLITE_MISMATCH;
        else rc = h_insert_step(stmt, table, object, -1, inserted);
    }
    sqlite3_finalize(stmt);
    if (rc) h_exec(db, "ROLLBACK TO history_list");
    int end = h_exec(db, "RELEASE history_list");
    return rc ? rc : end;
}

static int h_simple_match(J *param, int *operation, J **value)
{
    J *match = native_get(param, "_matchinfo");
    J *key = native_get(match, "keytype");
    if (!json_object_is_type(key, json_type_int)) return SQLITE_MISMATCH;
    *operation = json_object_get_int(key);
    *value = native_get(match, "match_value");
    return SQLITE_OK;
}

static int h_delete(struct im_db_context *ctx, enum history_table_id id, J *param)
{
    int op;
    J *value;
    int rc = h_simple_match(param, &op, &value);
    if (!rc && id == H_CALL) rc = h_history_ready(ctx);
    if (rc) return rc;
    const struct history_table *table = &tables[id];
    struct history_sql sql = h_sql("DELETE FROM ");
    g_string_append_printf(sql.text, "%s WHERE 1=1", table->name);
    if (id == H_CONVERSATION) {
        if (op == 0) h_equal(&sql, "AUTOID", value);
        else if (op == 13) h_equal(&sql, "CONVERSATION_ID", value);
        else if (op != 10) sql.error = SQLITE_MISMATCH;
    } else if (id == H_FILE || id == H_SCREEN) {
        if (op == 0) h_equal(&sql, "AUTOID", value);
        else if (op == 1) h_equal(&sql, "CONVERSATION_ID", value);
        else if (op == 3) h_equal(&sql, "SERVERMESSAGEID", value);
        else if (op == (id == H_FILE ? 25 : 22)) h_in(&sql, "SERVERMESSAGEID", value, 0);
        else if (op != 19) sql.error = SQLITE_MISMATCH;
    } else if (id == H_CALL) {
        if (op == 0) h_equal(&sql, "AUTOID", value);
        else if (op == 1) h_equal(&sql, "PEERACCOUNT", value);
        else if (op == 7) h_equal(&sql, "CONFID", value);
        else sql.error = SQLITE_MISMATCH;
    } else if (id == H_TRACK) {
        if (op == 0) h_equal(&sql, "AUTOID", value);
        else if (op == 3) {
            if (*h_text(value)) h_in(&sql, "AUTOID", value, 0);
        } else if (op == 4) {
            g_string_append(sql.text, " AND AUTOID NOT IN (SELECT AUTOID FROM UserTrackTab ORDER BY AUTOID DESC LIMIT ?)");
            h_number(&sql, h_int(value, 0));
        } else sql.error = SQLITE_MISMATCH;
    } else if (id == H_GROUP) {
        if (op == 2) h_equal(&sql, "CONVERSATION_GROUP_ID", value);
        else if (op == 9) h_in(&sql, "CONVERSATION_GROUP_ID", value, 0);
        else if (op != 0) sql.error = SQLITE_MISMATCH;
    }
    rc = h_run(im_db_database(ctx, table->database), &sql);
    h_sql_free(&sql);
    return rc;
}

static int h_conversations(struct im_db_context *ctx, J *param, J **result)
{
    J *match;
    int op, rc = h_multi(param, &match, &op);
    if (rc) return rc;
    struct history_sql sql = h_select(&tables[H_CONVERSATION]);
    const char *order = " ORDER BY STICKONTOP DESC,TIMESTAMP DESC";
    int64_t limit = h_int(h_match(match, 22), 0), offset = 0;
    switch (op) {
    case 0: h_equal(&sql, "AUTOID", h_match(match, 0)); order = ""; break;
    case 1: h_equal(&sql, "CONVERSATION_TYPE", h_match(match, 1)); break;
    case 2: h_equal(&sql, "ACCOUNT", h_match(match, 2)); order = ""; break;
    case 3: h_equal(&sql, "CONTACTAUTOID", h_match(match, 3)); order = ""; break;
    case 4: h_equal(&sql, "GROUPID", h_match(match, 4)); order = ""; break;
    case 11: h_equal(&sql, "CONTACTID", h_match(match, 11)); order = ""; break;
    case 13: h_equal(&sql, "CONVERSATION_ID", h_match(match, 13)); order = ""; break;
    case 10:
        if (h_int(h_match(match, 24), 0) == 1) g_string_append(sql.text, " AND ISDELETE!=1");
        limit = 300;
        break;
    case 20: {
        J *accounts = h_match(match, 2), *names = h_match(match, 20);
        size_t count = h_length(accounts);
        size_t words = h_length(names);
        if (!count && !words) { sql.error = SQLITE_MISMATCH; break; }
        g_string_append(sql.text, " AND CONVERSATION_ID IN (");
        for (size_t i = 0; i < count + words; ++i) {
            if (i) g_string_append(sql.text, " INTERSECT ");
            g_string_append(sql.text, "SELECT CONVERSATION_ID FROM SenderTab WHERE 1=1");
            if (i < count) h_equal(&sql, "ACCOUNT", json_object_array_get_idx(accounts, i));
            else {
                J *word = json_object_array_get_idx(names, i - count);
                g_string_append(sql.text, " AND (0=1");
                struct history_sql like = h_sql("");
                h_like(&like, "COMBINATION", word);
                g_string_append(sql.text, " OR ");
                g_string_append(sql.text, like.text->str + 5);
                h_value(&sql, json_object_array_get_idx(like.values, 0));
                g_string_truncate(like.text, 0);
                h_like(&like, "ACCOUNT", word);
                g_string_append(sql.text, " OR ");
                g_string_append(sql.text, like.text->str + 5);
                h_value(&sql, json_object_array_get_idx(like.values, 1));
                g_string_append_c(sql.text, ')');
                h_sql_free(&like);
            }
        }
        g_string_append_c(sql.text, ')');
        offset = h_int(h_match(match, 29), 0);
        break;
    }
    case 21: h_in(&sql, "CONVERSATION_ID", h_match(match, 21), 0); break;
    case 23:
        h_in(&sql, "GROUPID", h_match(match, 23), 0);
        order = " ORDER BY TIMESTAMP DESC";
        break;
    case 25: limit = 0; break;
    case 26:
        g_string_append(sql.text, " AND AUTOID IN (SELECT AUTOID FROM ConversationTab WHERE ISDELETEINHIS!=1 ORDER BY TIMESTAMP DESC LIMIT 1100)");
        order = " ORDER BY STICKONTOP DESC";
        limit = 0;
        break;
    case 27: g_string_append(sql.text, " AND ISDELETE!=1"); limit = 300; break;
    default: sql.error = SQLITE_MISMATCH;
    }
    g_string_append(sql.text, order);
    h_limit(&sql, limit, offset);
    J *rows = json_object_new_array();
    rc = h_query(im_db_database(ctx, "conversationdb"), &sql, &tables[H_CONVERSATION], 0, rows);
    h_sql_free(&sql);
    if (!rc) *result = h_list_result("_cvsinfolist", "_retlen", rows);
    else json_object_put(rows);
    return rc;
}

static int h_files(struct im_db_context *ctx, J *param, int screenshot, J **result)
{
    J *match;
    int op, rc = h_multi(param, &match, &op);
    if (rc) return rc;
    const struct history_table *table = &tables[screenshot ? H_SCREEN : H_FILE];
    struct history_sql sql = h_select(table);
    int paged = 0;
    if (op == 1 || op == 2 || op == 24) {
        h_equal(&sql, op == 2 ? "CONVERSATION_AUTOID" : "CONVERSATION_ID",
                h_match(match, op == 24 ? 1 : op));
        paged = *h_text(h_match(match, 18)) && *h_text(h_match(match, 21)) &&
                (!screenshot || op == 1);
        if (paged) {
            g_string_append(sql.text, " AND TIMESTAMP<?");
            h_value(&sql, h_match(match, 18));
            if (!screenshot && op != 24) h_like(&sql, "FILEREALNAME", h_match(match, 20));
        }
        if (op == 24) {
            if (screenshot || !paged) sql.error = SQLITE_MISMATCH;
            g_string_append(sql.text, " AND (FILEREALNAME LIKE '%.png' OR FILEREALNAME LIKE '%.jpg' OR FILEREALNAME LIKE '%.jpeg' OR FILEREALNAME LIKE '%.bmp' OR FILEREALNAME LIKE '%.gif')");
        }
    } else if (op == 3) h_equal(&sql, "RECORDID", h_match(match, 3));
    else if (op == 4) h_equal(&sql, "SERVERMESSAGEID", h_match(match, 4));
    else if (op == 6) h_equal(&sql, "FILEHANDLE", h_match(match, 6));
    else if (screenshot && op == 14) h_equal(&sql, "UMURL", h_match(match, 14));
    else if (!screenshot && op == 20) h_like(&sql, "FILEREALNAME", h_match(match, 20));
    else if (!screenshot && op == 25) h_in(&sql, "SERVERMESSAGEID", h_match(match, 25), 0);
    else if (op != 19) sql.error = SQLITE_MISMATCH;
    if (paged || op == 20) g_string_append(sql.text, " ORDER BY TIMESTAMP DESC");
    if (paged) h_limit(&sql, h_int(h_match(match, 21), 0), 0);
    J *rows = json_object_new_array();
    rc = h_query(im_db_database(ctx, table->database), &sql, table, 0, rows);
    h_sql_free(&sql);
    if (!rc) *result = h_list_result(screenshot ? "_screenfileinfolist" : "_filerecordlist", "_retlen", rows);
    else json_object_put(rows);
    return rc;
}

static int h_calls(struct im_db_context *ctx, J *param, J **result)
{
    J *match;
    int op, rc = h_multi(param, &match, &op);
    if (!rc) rc = h_history_ready(ctx);
    if (rc) return rc;
    struct history_sql sql = h_select(&tables[H_CALL]);
    if (op == 1) h_equal(&sql, "PEERACCOUNT", h_match(match, 1));
    else if (op == 10) h_equal(&sql, "GROUPID", h_match(match, 10));
    else if (op == 7) h_equal(&sql, "CONFID", h_match(match, 7));
    else if (op == 16) g_string_append(sql.text, " AND CONFID!=''");
    else if (op == 17) g_string_append(sql.text, " AND CONFID=''");
    else if (op != 14) sql.error = SQLITE_MISMATCH;
    g_string_append(sql.text, " AND STARTTIME<? ORDER BY STARTTIME DESC LIMIT ? OFFSET 0");
    h_number(&sql, h_int(h_match(match, 11), 0));
    h_number(&sql, h_int(h_match(match, 13), 0));
    J *rows = json_object_new_array();
    rc = h_query(im_db_database(ctx, "historydb"), &sql, &tables[H_CALL], 0, rows);
    h_sql_free(&sql);
    if (!rc) *result = h_list_result("_callrecordlist", "_retlen", rows);
    else json_object_put(rows);
    return rc;
}

static int h_tracks(struct im_db_context *ctx, J *param, J **result)
{
    J *value;
    int op, rc = h_simple_match(param, &op, &value);
    if (rc) return rc;
    struct history_sql sql = op == 5 ? h_sql("SELECT COUNT(*) FROM UserTrackTab") : h_select(&tables[H_TRACK]);
    if (op == 0) h_equal(&sql, "AUTOID", value);
    else if (op == 4) {
        g_string_append(sql.text, " LIMIT ?");
        h_number(&sql, h_int(value, 0));
    } else if (op != 3 && op != 5) sql.error = SQLITE_MISMATCH;
    sqlite3 *db = im_db_database(ctx, "sysdb");
    J *rows = json_object_new_array();
    if (op == 5) {
        sqlite3_stmt *stmt = NULL;
        rc = h_prepare(db, &sql, &stmt);
        if (!rc) {
            rc = sqlite3_step(stmt);
            if (rc == SQLITE_ROW) {
                *result = json_object_new_object();
                json_object_object_add(*result, "_retlen", json_object_new_int64(sqlite3_column_int64(stmt, 0)));
                rc = SQLITE_OK;
            }
        }
        sqlite3_finalize(stmt);
        json_object_put(rows);
    } else {
        rc = h_query(db, &sql, &tables[H_TRACK], 0, rows);
        if (!rc) *result = h_list_result("_usertrackinfolist", "_retlen", rows);
        else json_object_put(rows);
    }
    h_sql_free(&sql);
    return rc;
}

static int h_groups(struct im_db_context *ctx, J *param, int member, int detail, J **result)
{
    J *value;
    int op, rc = h_simple_match(param, &op, &value);
    if (rc) return rc;
    const struct history_table *table = &tables[detail ? H_CONVERSATION : member ? H_MEMBER : H_GROUP];
    struct history_sql sql = h_select(table);
    if (detail) g_string_append(sql.text, " AND CONVERSATION_ID IN (SELECT CONVERSATION_ID FROM ConversationGroupMemberTab WHERE 1=1");
    if (op == 2) h_equal(&sql, "CONVERSATION_GROUP_ID", value);
    else if (!member && op == 9) h_in(&sql, "CONVERSATION_GROUP_ID", value, 0);
    else if (op != 0) sql.error = SQLITE_MISMATCH;
    if (detail) g_string_append_c(sql.text, ')');
    J *rows = json_object_new_array();
    rc = h_query(im_db_database(ctx, "conversationdb"), &sql, table, 0, rows);
    h_sql_free(&sql);
    if (!rc) {
        if (detail && !json_object_array_length(rows)) json_object_put(rows);
        else *result = h_list_result(detail ? "_cvsinfolist" : member ? "conversationGroupMemberInfoList" : "conversationGroupInfoList",
                                     detail ? "_retlen" : "listLen", rows);
    } else json_object_put(rows);
    return rc;
}

static int h_group_update(struct im_db_context *ctx, J *param, int command)
{
    sqlite3 *db = im_db_database(ctx, "conversationdb");
    if (command == 146) {
        J *list = native_get(param, "sortInfoList");
        int64_t count = native_integer(param, "listLen", -1);
        if (!json_object_is_type(list, json_type_array) || count < 0 ||
            (uint64_t)count > json_object_array_length(list)) return SQLITE_MISMATCH;
        int rc = h_exec(db, "SAVEPOINT history_sort");
        if (rc) return rc;
        sqlite3_stmt *stmt = NULL;
        rc = sqlite3_prepare_v2(db, "UPDATE ConversationGroupTab SET IDX_NO=?,MODIFY_TIME=? WHERE CONVERSATION_GROUP_ID=?",
                                -1, &stmt, NULL);
        for (int64_t i = 0; !rc && i < count; ++i) {
            J *row = json_object_array_get_idx(list, (size_t)i);
            rc = sqlite3_bind_int64(stmt, 1, native_integer(row, "idxNo", 0));
            if (!rc) rc = sqlite3_bind_text(stmt, 2, native_string(row, "modifyTime", ""), -1, SQLITE_STATIC);
            if (!rc) rc = sqlite3_bind_text(stmt, 3, native_string(row, "conversationGroupId", ""), -1, SQLITE_STATIC);
            if (!rc) rc = sqlite3_step(stmt);
            if (rc == SQLITE_DONE) rc = SQLITE_OK;
            int reset = sqlite3_reset(stmt);
            sqlite3_clear_bindings(stmt);
            if (!rc) rc = reset;
        }
        sqlite3_finalize(stmt);
        if (rc) h_exec(db, "ROLLBACK TO history_sort");
        int end = h_exec(db, "RELEASE history_sort");
        return rc ? rc : end;
    }
    J *match;
    int op, rc = h_multi(param, &match, &op);
    if (rc) return rc;
    struct history_sql sql = h_sql("");
    if (command == 145) {
        g_string_append(sql.text, "UPDATE ConversationGroupTab SET CN_NAME=?,EN_NAME=?,MODIFY_TIME=? WHERE CONVERSATION_GROUP_ID=?");
        if (op != 10) sql.error = SQLITE_MISMATCH;
        h_value(&sql, h_match(match, 3));
        h_value(&sql, h_match(match, 4));
        h_value(&sql, h_match(match, 8));
        h_value(&sql, h_match(match, 2));
    } else if (command == 150) {
        g_string_append(sql.text, "DELETE FROM ConversationGroupMemberTab WHERE 1=1");
        if (op == 2 || op == 7 || op == 9) h_equal(&sql, "CONVERSATION_GROUP_ID", h_match(match, 2));
        if (op == 6) h_in(&sql, "CONVERSATION_GROUP_ID", h_match(match, 6), 0);
        else if (op == 7) h_equal(&sql, "CONVERSATION_ID", h_match(match, 3));
        else if (op == 9) h_in(&sql, "CONVERSATION_ID", h_match(match, 8), 0);
        else if (op != 0 && op != 2) sql.error = SQLITE_MISMATCH;
    } else {
        g_string_append(sql.text, "UPDATE ConversationTab SET ISDELETE=? WHERE STICKONTOP=0");
        if (op != 28) sql.error = SQLITE_MISMATCH;
        h_number(&sql, h_int(h_match(match, 8), 0));
        if (*h_text(h_match(match, 9))) {
            g_string_append(sql.text, " AND TIMESTAMP<=?");
            h_value(&sql, h_match(match, 9));
        }
    }
    rc = h_run(db, &sql);
    h_sql_free(&sql);
    return rc;
}

static int h_accounts(struct im_db_context *ctx, J *param, int sort, J **result)
{
    struct history_sql sql = h_sql("SELECT ACCOUNT FROM ConversationTab WHERE 1=1");
    if (sort) {
        J *list = native_get(param, "WeLinkIdList");
        int64_t count = native_integer(param, "WeLinkIdListLength", -1);
        if (!json_object_is_type(list, json_type_array) || count < 0 ||
            (uint64_t)count != json_object_array_length(list)) sql.error = SQLITE_MISMATCH;
        h_in(&sql, "ACCOUNT", list, 0);
    } else {
        h_value(&sql, native_get(param, "rcType"));
        g_string_append(sql.text, " AND CONVERSATION_TYPE=? AND ISDELETEINHIS!=1");
    }
    g_string_append(sql.text, " ORDER BY RECEIVERLASTMARKTIME DESC");
    if (!sort) {
        if (!json_object_is_type(native_get(param, "rcLimit"), json_type_int)) sql.error = SQLITE_MISMATCH;
        h_limit(&sql, native_integer(param, "rcLimit", 0), 0);
    }
    sqlite3_stmt *stmt = NULL;
    int rc = h_prepare(im_db_database(ctx, "conversationdb"), &sql, &stmt);
    J *list = json_object_new_array();
    if (!rc) {
        while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
            const char *text = (const char *)sqlite3_column_text(stmt, 0);
            json_object_array_add(list, json_object_new_string(text ? text : ""));
        }
        if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    sqlite3_finalize(stmt);
    h_sql_free(&sql);
    if (!rc) {
        *result = json_object_new_object();
        if (json_object_array_length(list))
            json_object_object_add(*result, sort ? "sortAccountList" : "accountList", list);
        else {
            json_object_put(list);
            json_object_object_add(*result, sort ? "sortAccountList" : "accountList", NULL);
        }
    } else json_object_put(list);
    return rc;
}

/* DatabaseInfo.dat is the original line-oriented format, not JSON:
 * database-name#key-file#max-timestamp#min-timestamp#max-message-id#min-message-id#number.
 * The live historydb entry is synthesized after the archive entries by the DLL.
 * Metadata is reloaded for each operation, so command 129 and external imports
 * cannot leave stale archive identities cached in a long-lived service. */
struct history_database {
    char **info;
    unsigned number;
    sqlite3 *db;
    sqlite3_stmt *insert;
    int transaction;
    int durable;
    int borrowed;
};

static void h_database_free(gpointer pointer)
{
    struct history_database *entry = pointer;
    sqlite3_finalize(entry->insert);
    if (!entry->borrowed && entry->db) sqlite3_close(entry->db);
    g_strfreev(entry->info);
    g_free(entry);
}

static int h_databases(struct im_db_context *ctx, GPtrArray **out)
{
    *out = g_ptr_array_new_with_free_func(h_database_free);
    const char *directory = im_db_directory(ctx);
    if (!directory || !*directory) return SQLITE_CANTOPEN;
    char *path = g_build_filename(directory, "ArchiveFiles", "DatabaseInfo.dat", NULL);
    char *contents = NULL;
    GError *error = NULL;
    int rc = SQLITE_OK;
    if (g_file_get_contents(path, &contents, NULL, &error)) {
        char **lines = g_strsplit(contents, "\n", -1);
        for (size_t i = 0; lines[i]; ++i) {
            g_strchomp(lines[i]);
            if (!*lines[i]) continue;
            char **fields = g_strsplit(lines[i], "#", -1);
            if (g_strv_length(fields) != 7 || !*fields[0] ||
                strchr(fields[0], '/') || strchr(fields[0], '\\') ||
                !strcmp(fields[0], ".") || !strcmp(fields[0], "..")) {
                g_strfreev(fields);
                rc = SQLITE_CORRUPT;
                break;
            }
            char *end = NULL;
            errno = 0;
            guint64 number = g_ascii_strtoull(fields[6], &end, 10);
            if (errno || !*fields[6] || *end || number != (*out)->len) {
                g_strfreev(fields);
                rc = SQLITE_CORRUPT;
                break;
            }
            /* The normal writer stores only archived databases. Migration-mode
             * metadata can include historydb; its identity is retained. */
            struct history_database *entry = g_new0(struct history_database, 1);
            entry->info = fields;
            entry->number = (unsigned)number;
            entry->borrowed = !strcmp(fields[0], "historydb");
            if (entry->borrowed) entry->db = im_db_database(ctx, "historydb");
            g_ptr_array_add(*out, entry);
        }
        g_strfreev(lines);
    } else if (!g_error_matches(error, G_FILE_ERROR, G_FILE_ERROR_NOENT)) {
        rc = SQLITE_IOERR_READ;
    }
    g_clear_error(&error);
    g_free(contents);
    g_free(path);
    if (rc) return rc;
    int live = 0;
    for (guint i = 0; i < (*out)->len; ++i)
        if (((struct history_database *)g_ptr_array_index(*out, i))->borrowed) live = 1;
    if (!live) {
        struct history_database *entry = g_new0(struct history_database, 1);
        entry->number = (*out)->len;
        entry->db = im_db_database(ctx, "historydb");
        entry->borrowed = 1;
        entry->info = g_new0(char *, 8);
        entry->info[0] = g_strdup("historydb");
        entry->info[1] = g_strdup("config_private.db");
        for (size_t i = 2; i < 6; ++i) entry->info[i] = g_strdup("");
        entry->info[6] = g_strdup_printf("%u", entry->number);
        g_ptr_array_add(*out, entry);
    }
    return SQLITE_OK;
}

static int h_open(struct im_db_context *ctx, struct history_database *entry)
{
    if (entry->db) return SQLITE_OK;
    if (entry->borrowed) return SQLITE_CANTOPEN;
    char *path = g_build_filename("ArchiveFiles", entry->info[0], NULL);
    char *key = g_build_filename("ArchiveFiles", entry->info[1], NULL);
    int rc = im_db_open_archive(ctx, path, key, 0, &entry->db);
    g_free(key);
    g_free(path);
    return rc;
}

static int h_record_id(J *value, int64_t *id, unsigned *number)
{
    *id = 0;
    *number = 0;
    if (!value || !*h_text(value)) return SQLITE_OK;
    const char *text = h_text(value);
    char *end = NULL;
    errno = 0;
    int64_t parsed = g_ascii_strtoll(text, &end, 10);
    if (errno || end == text) return SQLITE_MISMATCH;
    *id = parsed;
    if (*end == '#') {
        const char *suffix = end + 1;
        errno = 0;
        guint64 n = g_ascii_strtoull(suffix, &end, 10);
        if (errno || end == suffix || *end || n > UINT_MAX) return SQLITE_MISMATCH;
        *number = (unsigned)n;
    } else if (*end) return SQLITE_MISMATCH;
    return SQLITE_OK;
}

static struct history_database *h_numbered(GPtrArray *databases, unsigned number)
{
    for (guint i = 0; i < databases->len; ++i) {
        struct history_database *entry = g_ptr_array_index(databases, i);
        if (entry->number == number) return entry;
    }
    return NULL;
}

static struct history_database *h_route(GPtrArray *databases, const char *message, const char *stamp)
{
    struct history_database *live = NULL;
    char *end = NULL;
    errno = 0;
    int64_t message_id = g_ascii_strtoll(message, &end, 10);
    int valid = !errno && end != message && !*end &&
                strlen(message) >= 17 && strlen(message) <= 18 &&
                message_id >= INT64_C(50000000000000001) &&
                message_id <= INT64_C(199999999999999999);
    for (guint i = 0; i < databases->len; ++i) {
        struct history_database *entry = g_ptr_array_index(databases, i);
        if (entry->borrowed) { live = entry; continue; }
        if (valid && *entry->info[4]) {
            if (message_id <= g_ascii_strtoll(entry->info[4], NULL, 10)) return entry;
        } else if (!valid && *stamp && *entry->info[2] && strcmp(stamp, entry->info[2]) <= 0) {
            return entry;
        }
    }
    return live;
}

static int h_sender(sqlite3_stmt *stmt, J *record)
{
    static const char *const keys[] = {"convid", "originaccount", "peername", "peernativename"};
    int rc = SQLITE_OK;
    for (size_t i = 0; !rc && i < HCOUNT(keys); ++i)
        rc = sqlite3_bind_text(stmt, (int)i + 1, native_string(record, keys[i], ""), -1, SQLITE_STATIC);
    if (!rc) rc = sqlite3_step(stmt);
    if (rc == SQLITE_DONE) rc = SQLITE_OK;
    int end = sqlite3_reset(stmt);
    sqlite3_clear_bindings(stmt);
    return rc ? rc : end;
}

/* Independent SQLite databases cannot share a commit. A move therefore keeps
 * its source until every destination copy has committed. The original message
 * identities and canonical inserted fields are sufficient to reconcile a retry
 * after a crash; no new persistent move journal or metadata format is needed. */
struct history_move {
    struct history_database *source, *destination;
    J *record; /* Borrowed from the request, which outlives reconciliation. */
    sqlite3_value **source_values;
    int ignore;
};

static void h_clear_move(struct history_move *move)
{
    if (!move->source_values) return;
    for (size_t i = 0; i < tables[H_RECORD].count; ++i)
        sqlite3_value_free(move->source_values[i]);
    g_free(move->source_values);
    move->source_values = NULL;
}

static void h_invalidate_moves(GArray *moves, struct history_database *database, int64_t id)
{
    if (!moves) return;
    for (guint i = 0; i < moves->len; ++i) {
        struct history_move *move = &g_array_index(moves, struct history_move, i);
        if (move->source_values && move->source == database &&
            sqlite3_value_int64(move->source_values[0]) == id)
            h_clear_move(move);
    }
}

static int h_finish_history_transaction(sqlite3 *db, const char *release, int status)
{
    if (status) {
        h_exec(db, "ROLLBACK");
        return status;
    }
    int rc = h_exec(db, release);
    if (rc) h_exec(db, "ROLLBACK");
    return rc;
}

static int h_move_source(struct history_move *move, int remove, int *present)
{
    const struct history_table *table = &tables[H_RECORD];
    GString *sql = g_string_new(remove ? "DELETE FROM RecordTab WHERE " : "SELECT 1 FROM RecordTab WHERE ");
    for (size_t i = 0; i < table->count; ++i)
        g_string_append_printf(sql, "%s%s IS ?", i ? " AND " : "", table->fields[i].column);
    sqlite3_stmt *stmt = NULL;
    int rc = sqlite3_prepare_v2(move->source->db, sql->str, -1, &stmt, NULL);
    g_string_free(sql, TRUE);
    for (size_t i = 0; !rc && i < table->count; ++i) {
        sqlite3_value *value = move->source_values[i];
        switch (sqlite3_value_type(value)) {
        case SQLITE_INTEGER:
            rc = sqlite3_bind_int64(stmt, (int)i + 1, sqlite3_value_int64(value));
            break;
        case SQLITE_FLOAT:
            rc = sqlite3_bind_double(stmt, (int)i + 1, sqlite3_value_double(value));
            break;
        case SQLITE_TEXT: {
            const char *text = (const char *)sqlite3_value_text(value);
            rc = text ? sqlite3_bind_text(stmt, (int)i + 1, text, sqlite3_value_bytes(value), SQLITE_STATIC)
                      : SQLITE_NOMEM;
            break;
        }
        case SQLITE_BLOB: {
            int bytes = sqlite3_value_bytes(value);
            rc = bytes ? sqlite3_bind_blob(stmt, (int)i + 1, sqlite3_value_blob(value), bytes, SQLITE_STATIC)
                       : sqlite3_bind_zeroblob(stmt, (int)i + 1, 0);
            break;
        }
        default:
            rc = sqlite3_bind_null(stmt, (int)i + 1);
            break;
        }
    }
    if (!rc) {
        rc = sqlite3_step(stmt);
        if (rc == SQLITE_ROW || rc == SQLITE_DONE) {
            if (present) *present = rc == SQLITE_ROW;
            rc = SQLITE_OK;
        }
    }
    int end = sqlite3_finalize(stmt);
    return rc ? rc : end;
}

static int h_move_destination(struct history_move *move, int *matches)
{
    const struct history_table *table = &tables[H_RECORD];
    struct history_sql sql = h_select(table);
    g_string_append(sql.text, " AND SERVERMESSAGEID=?");
    json_object_array_add(sql.values, json_object_new_string(native_string(move->record, "servermessageid", "")));
    sqlite3_stmt *stmt = NULL;
    int rc = h_prepare(move->destination->db, &sql, &stmt);
    *matches = 0;
    if (!rc) {
        rc = sqlite3_step(stmt);
        if (rc == SQLITE_ROW) {
            *matches = 1;
            for (size_t i = 1; *matches && i < table->count; ++i) {
                const struct history_field *field = &table->fields[i];
                int type = sqlite3_column_type(stmt, (int)i);
                if (!strcmp(field->column, "UTCDATE")) {
                    *matches = type == SQLITE_NULL;
                } else if (field->string_value) {
                    const char *expected = native_string(move->record, field->key, "");
                    size_t length = strlen(expected);
                    *matches = type == SQLITE_TEXT &&
                        length == (size_t)sqlite3_column_bytes(stmt, (int)i) &&
                        !memcmp(sqlite3_column_text(stmt, (int)i), expected, length);
                } else {
                    *matches = type == SQLITE_INTEGER &&
                        sqlite3_column_int64(stmt, (int)i) ==
                        native_integer(move->record, field->key, field->initial);
                }
            }
            rc = SQLITE_OK;
        } else if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    int end = sqlite3_finalize(stmt);
    h_sql_free(&sql);
    return rc ? rc : end;
}

static int h_move_durable(struct history_database *destination)
{
    if (destination->durable) return SQLITE_OK;
    if (!sqlite3_get_autocommit(destination->db)) return SQLITE_BUSY;
    /* FULL checkpoints synchronize committed WAL data even on a connection
     * configured for NORMAL commits. Sync the database VFS file as well so a
     * rollback-journal connection cannot lose its copy after source cleanup. */
    int rc = sqlite3_wal_checkpoint_v2(destination->db, "main", SQLITE_CHECKPOINT_FULL, NULL, NULL);
    sqlite3_file *file = NULL;
    if (!rc) rc = sqlite3_file_control(destination->db, "main", SQLITE_FCNTL_FILE_POINTER, &file);
    if (!rc) rc = file && file->pMethods && file->pMethods->xSync
        ? file->pMethods->xSync(file, SQLITE_SYNC_FULL) : SQLITE_IOERR_FSYNC;
    if (!rc) destination->durable = 1;
    return rc;
}

static int h_reconcile_move(struct history_move *move)
{
    if (!move->source_values) return SQLITE_OK;
    if (!sqlite3_get_autocommit(move->source->db) ||
        !sqlite3_get_autocommit(move->destination->db)) return SQLITE_BUSY;
    int rc = h_move_durable(move->destination);
    if (rc) return rc;
    /* Keep other writers from replacing the verified copy while its source is
     * deleted. These new transactions do not contain the destination insert. */
    rc = h_exec(move->destination->db, "BEGIN IMMEDIATE");
    if (rc) return rc;
    int source_transaction = 0, present = 0, matches = 0;
    rc = h_exec(move->source->db, "BEGIN IMMEDIATE");
    if (!rc) source_transaction = 1;
    if (!rc) rc = h_move_source(move, 0, &present);
    if (!rc && present) rc = h_move_destination(move, &matches);
    if (!rc && present && matches) rc = h_move_source(move, 1, NULL);
    else if (!rc && present && !move->ignore) rc = SQLITE_CONSTRAINT;
    if (source_transaction)
        rc = h_finish_history_transaction(move->source->db, "COMMIT", rc);
    int end = h_exec(move->destination->db, "ROLLBACK");
    return rc ? rc : end;
}

static int h_add_record(struct im_db_context *ctx, GPtrArray *databases, J *record,
                        sqlite3_stmt *sender, GArray **moves, int ignore,
                        int64_t *inserted, unsigned *number)
{
    if (!json_object_is_type(record, json_type_object)) return SQLITE_MISMATCH;
    int64_t id;
    unsigned source_number;
    int rc = h_record_id(native_get(record, "recordid"), &id, &source_number);
    if (rc) return rc;
    struct history_database *target = h_route(databases,
        native_string(record, "servermessageid", ""), native_string(record, "utcstamp", ""));
    struct history_database *source = id > 0 ? h_numbered(databases, source_number) : NULL;
    if (!target || (id > 0 && !source)) return SQLITE_NOTFOUND;
    int move = source && source != target, source_present = 0;
    struct history_move pending = {source, target, record, NULL, ignore};
    if (move) {
        rc = h_open(ctx, source);
        struct history_sql query = h_select(&tables[H_RECORD]);
        g_string_append(query.text, " AND RECORD_ID=?");
        h_number(&query, id);
        sqlite3_stmt *stmt = NULL;
        if (!rc) rc = h_prepare(source->db, &query, &stmt);
        if (!rc) {
            int step = sqlite3_step(stmt);
            if (step == SQLITE_ROW) {
                const char *server = (const char *)sqlite3_column_text(stmt, 3);
                const char *client = (const char *)sqlite3_column_text(stmt, 4);
                const char *requested_server = native_string(record, "servermessageid", "");
                const char *requested_client = native_string(record, "clientmessageid", "");
                if ((!server || strcmp(server, requested_server)) &&
                    (!client || !*client || strcmp(client, requested_client))) {
                    target = source;
                    move = 0;
                } else {
                    source_present = 1;
                    pending.source_values = g_new0(sqlite3_value *, tables[H_RECORD].count);
                    for (size_t i = 0; !rc && i < tables[H_RECORD].count; ++i) {
                        pending.source_values[i] = sqlite3_value_dup(sqlite3_column_value(stmt, (int)i));
                        if (!pending.source_values[i]) rc = SQLITE_NOMEM;
                    }
                }
            } else if (step != SQLITE_DONE) rc = step;
        }
        sqlite3_finalize(stmt);
        h_sql_free(&query);
    }
    if (!rc) rc = h_open(ctx, target);
    if (!rc && !target->transaction) {
        if (!sqlite3_get_autocommit(target->db)) rc = SQLITE_BUSY;
        else rc = h_exec(target->db, "SAVEPOINT history_records");
        target->transaction = rc == SQLITE_OK;
    }
    if (!rc && !target->insert) rc = h_insert_prepare(target->db, &tables[H_RECORD], ignore, &target->insert);
    if (!rc) rc = h_insert_step(target->insert, &tables[H_RECORD], record, move ? 0 : id, inserted);
    /* A later write to an old source ID supersedes an earlier pending move,
     * even when the later request writes identical values. */
    if (!rc && *inserted) h_invalidate_moves(*moves, target, *inserted);
    if (!rc) rc = h_sender(sender, record);
    if (!rc && move && source_present) {
        if (!*moves) *moves = g_array_new(FALSE, FALSE, sizeof(struct history_move));
        g_array_append_val(*moves, pending);
    } else {
        h_clear_move(&pending);
    }
    *number = target->number;
    return rc;
}

static int h_add_history(struct im_db_context *ctx, J *param, int command, J **result, int64_t *native_result)
{
    int special = command == 131 || command == 132;
    int single = command == 54 || command == 131;
    const struct history_table *table = &tables[H_RECORD];
    if (special) {
        int type = (int)native_integer(param, "specialmsgtype", 0);
        if (type < 1 || type > 3) return SQLITE_MISMATCH;
        table = &tables[H_OFFICIAL + type - 1];
    }
    J *list = native_get(param, single ? "_historyrecord" : "_historyrecordlist");
    int64_t count = single ? 1 : native_integer(param, "_arraylen", -1);
    if (single ? !json_object_is_type(list, json_type_object) :
        !json_object_is_type(list, json_type_array) || count < 0 ||
        (uint64_t)count > json_object_array_length(list)) return SQLITE_MISMATCH;
    int rc = special ? SQLITE_OK : h_history_ready(ctx);
    if (rc) return rc;
    GPtrArray *databases = NULL;
    GArray *moves = NULL;
    rc = special ? SQLITE_OK : h_databases(ctx, &databases);
    int64_t inserted = 0;
    unsigned number = 0;
    sqlite3 *side_db = im_db_database(ctx, special ? "specialMsgdb" : "conversationdb");
    sqlite3_stmt *stmt = NULL;
    int transaction = 0, all_inserted = 1;
    if (!rc) {
        rc = side_db && sqlite3_get_autocommit(side_db)
            ? h_exec(side_db, "SAVEPOINT history_side") : SQLITE_BUSY;
        transaction = rc == SQLITE_OK;
    }
    if (!rc && special) rc = h_insert_prepare(side_db, table, 0, &stmt);
    else if (!rc) rc = sqlite3_prepare_v2(side_db,
        "REPLACE INTO SenderTab(RECORD_ID,CONVERSATION_ID,ACCOUNT,PEERNAME,PEERNATIVENAME,PINYIN,COMBINATION)"
        " VALUES(NULL,?1,?2,?3,?4,'',?4||char(13,10)||?3)", -1, &stmt, NULL);
    for (int64_t i = 0; !rc && i < count; ++i) {
        J *record = single ? list : json_object_array_get_idx(list, (size_t)i);
        if (special) {
            int64_t id;
            rc = h_record_id(native_get(record, "recordid"), &id, &number);
            if (!rc) rc = h_insert_step(stmt, table, record, id, &inserted);
        } else rc = h_add_record(ctx, databases, record, stmt, &moves, command == 118, &inserted, &number);
        if (!inserted) all_inserted = 0;
    }
    sqlite3_finalize(stmt);
    if (databases) {
        for (guint i = 0; i < databases->len; ++i) {
            struct history_database *entry = g_ptr_array_index(databases, i);
            if (!entry->transaction) continue;
            rc = h_finish_history_transaction(entry->db, "RELEASE history_records", rc);
            entry->transaction = 0;
        }
    }
    if (transaction)
        rc = h_finish_history_transaction(side_db, "RELEASE history_side", rc);
    if (moves) {
        /* Latest requests win when a batch repeats an identity. Cleanup starts
         * only after all copy and sender transactions have committed; failures
         * before this point leave every source available for an exact retry. */
        for (guint i = moves->len; !rc && i > 0; --i)
            rc = h_reconcile_move(&g_array_index(moves, struct history_move, i - 1));
        for (guint i = 0; i < moves->len; ++i) {
            h_clear_move(&g_array_index(moves, struct history_move, i));
        }
        g_array_free(moves, TRUE);
    }
    if (databases) g_ptr_array_free(databases, TRUE);
    if (!rc) *native_result = single ? inserted : all_inserted;
    if (!rc && single) {
        *result = json_object_new_object();
        if (special) json_object_object_add(*result, "recordId", json_object_new_int64(inserted));
        else {
            char identity[64];
            snprintf(identity, sizeof identity, "%" PRId64 "#%u", inserted, number);
            json_object_object_add(*result, "recordId", json_object_new_string(identity));
        }
    }
    return rc;
}

/* Numeric history key types are ABI values; their order differs from columns. */
static const char *h_history_column(int key)
{
    static const char *const first[] = {
        "RECORD_ID", "CONVERSATION_ID", "CONVERSATION_AUTOID", "SERVERMESSAGEID",
        "CLIENTMESSAGEID", "RECORDTYPE", "CONTENT", "CONTENTTYPE", "DELIVERTIME",
        "FILELIST", "GROUPID", "GROUPNAME", "PEERNAME", "PEERNATIVENAME",
        "ORIGINACCOUNT", "TARGETACCOUNT", "SHOWHTML", "SHOWTEXT", "ISREAD",
        "MEDIATYPE", "ISDELETE", "SOURCEFLAG", "QUOTE", "TIMESTAMP", "UTCSTAMP"
    };
    if (key >= 0 && key < (int)HCOUNT(first)) return first[key];
    switch (key) {
    case 40: return "RECEIPTSTATE";
    case 41: return "ISWITHDRAW";
    case 45: return "STATUS";
    case 46: return "SUBMSGTYPE";
    case 47: return "SHOWTRANSLATE";
    case 48: return "PROVIDERCN";
    case 49: return "PROVIDEREN";
    case 50: return "COMBINEMESSAGEFILELIST";
    case 51: return "RECEIPTCOUNT";
    case 52: return "DURATION";
    case 53: return "SOURCE";
    case 54: return "FILE_SIZE";
    case 55: return "EXTRA";
    case 56: return "ATTACH_URL";
    case 58: return "ISAPPMSG";
    case 59: return "APPSERVICEID";
    case 60: return "APPSERVICENAME";
    default: return NULL;
    }
}

static int h_history_write_sql(struct history_sql *sql, const char *table, J *param,
                               int update, unsigned database_number)
{
    int op, rc;
    J *match = NULL, *value = NULL;
    if (!update) {
        rc = h_simple_match(param, &op, &value);
        if (rc) return rc;
        g_string_printf(sql->text, "DELETE FROM %s WHERE 1=1", table);
        if (op == 0) {
            int64_t id;
            unsigned number;
            rc = h_record_id(value, &id, &number);
            if (rc) return rc;
            g_string_append(sql->text, number == database_number ? " AND RECORD_ID=?" : " AND 0=1 AND RECORD_ID=?");
            h_number(sql, id);
        } else if (op == 1) h_equal(sql, "CONVERSATION_ID", value);
        else if (op == 3) h_equal(sql, "SERVERMESSAGEID", value);
        else if (op != 38) return SQLITE_MISMATCH;
        return sql->error;
    }
    rc = h_multi(param, &match, &op);
    if (rc) return rc;
    g_string_printf(sql->text, "UPDATE %s SET ", table);
    if (op == 57 || op == 62) {
        size_t fields = 0;
        J *data = native_get(match, "datalist");
        size_t n = (size_t)native_integer(match, "datalen", 0);
        for (size_t i = 0; i < n; ++i) {
            J *item = json_object_array_get_idx(data, i);
            int key = (int)native_integer(item, "keytype", -1);
            const char *column = h_history_column(key);
            if (!column || key == 0) continue;
            g_string_append_printf(sql->text, "%s%s=?", fields++ ? "," : "", column);
            h_value(sql, native_get(item, "match_value"));
        }
        if (!fields) return SQLITE_MISMATCH;
    } else if (op == 31 || op == 32 || op == 33) {
        g_string_append(sql->text, "ISREAD=?");
        h_number(sql, h_int(h_match(match, 18), 0));
    } else if (op == 34 || op == 35) {
        g_string_append(sql->text, op == 34 ? "SHOWHTML=?" : "SHOWTEXT=?");
        h_value(sql, h_match(match, op == 34 ? 16 : 17));
    } else if (op == 36) {
        g_string_append(sql->text, "SHOWHTML=?,SHOWTEXT=?");
        h_value(sql, h_match(match, 16));
        h_value(sql, h_match(match, 17));
    } else if (op == 37 || op == 3) {
        g_string_append(sql->text, "SERVERMESSAGEID=?,UTCSTAMP=?");
        h_value(sql, h_match(match, 3));
        h_value(sql, h_match(match, 24));
        if (op == 37) {
            g_string_append(sql->text, ",TIMESTAMP=?");
            h_value(sql, h_match(match, 24));
        }
    } else return SQLITE_MISMATCH;
    g_string_append(sql->text, " WHERE 1=1");
    if (op == 31 || op == 33) {
        h_equal(sql, "CONVERSATION_ID", h_match(match, 1));
        if (op == 31) g_string_append(sql->text, " AND ISREAD=1");
        else {
            g_string_append(sql->text, " AND SERVERMESSAGEID<?");
            h_value(sql, h_match(match, 3));
        }
    } else if (op == 3) h_equal(sql, "CLIENTMESSAGEID", h_match(match, 4));
    else if (op == 36) h_equal(sql, "SERVERMESSAGEID", h_match(match, 3));
    else if (op == 62) {
        J *ids = h_match(match, 61);
        if (!ids) ids = h_match(match, 0);
        if (!json_object_is_type(ids, json_type_array)) return SQLITE_MISMATCH;
        J *local_ids = json_object_new_array();
        for (size_t i = 0; i < json_object_array_length(ids); ++i) {
            int64_t id;
            unsigned number;
            rc = h_record_id(json_object_array_get_idx(ids, i), &id, &number);
            if (rc) break;
            if (number == database_number) json_object_array_add(local_ids, json_object_new_int64(id));
        }
        if (!rc) h_in(sql, "RECORD_ID", local_ids, 0);
        json_object_put(local_ids);
        if (rc) return rc;
    } else {
        int64_t id;
        unsigned number;
        rc = h_record_id(h_match(match, 0), &id, &number);
        if (rc) return rc;
        if (number != database_number) g_string_append(sql->text, " AND 0=1");
        g_string_append(sql->text, " AND RECORD_ID=?");
        h_number(sql, id);
    }
    return sql->error;
}

static int h_history_write(struct im_db_context *ctx, J *param, int command)
{
    int rc = h_history_ready(ctx);
    if (rc) return rc;
    GPtrArray *databases = NULL;
    rc = h_databases(ctx, &databases);
    J *match = NULL;
    int op = -1;
    struct history_database *selected = NULL;
    if (!rc && command == 58) rc = h_multi(param, &match, &op);
    if (!rc && command == 58 && (op == 3 || op == 33 || op == 36 || op == 37)) {
        selected = h_route(databases, h_text(h_match(match, 3)), h_text(h_match(match, 24)));
        if (!selected) rc = SQLITE_NOTFOUND;
    }
    for (guint i = 0; !rc && i < databases->len; ++i) {
        struct history_database *entry = g_ptr_array_index(databases, i);
        if (selected && selected != entry) continue;
        rc = h_open(ctx, entry);
        struct history_sql sql = h_sql("");
        if (!rc) rc = h_history_write_sql(&sql, "RecordTab", param, command == 58, entry->number);
        if (!rc) rc = h_run(entry->db, &sql);
        h_sql_free(&sql);
    }
    g_ptr_array_free(databases, TRUE);
    return rc;
}

static void h_optional_compare(struct history_sql *sql, const char *column,
                                const char *comparison, J *value)
{
    if (!value || (json_object_is_type(value, json_type_string) && !*h_text(value))) return;
    g_string_append_printf(sql->text, " AND %s%s?", column, comparison);
    h_value(sql, value);
}

static void h_words(struct history_sql *sql, const char *column, J *words)
{
    if (json_object_is_type(words, json_type_array)) {
        for (size_t i = 0; i < json_object_array_length(words); ++i)
            h_like(sql, column, json_object_array_get_idx(words, i));
    } else if (*h_text(words)) h_like(sql, column, words);
}

static int h_record_filter(struct history_sql *sql, J *match, int op,
                           unsigned database_number, int special)
{
    int ascending = h_int(h_match(match, 27), 0) != 0;
    if (special && op != 1 && op != 3) return SQLITE_MISMATCH;
    if (op == 0) {
        int64_t id;
        unsigned number;
        int rc = h_record_id(h_match(match, 0), &id, &number);
        if (rc) return rc;
        if (number != database_number) g_string_append(sql->text, " AND 0=1");
        g_string_append(sql->text, " AND RECORD_ID=? AND ISDELETE!=1");
        h_number(sql, id);
    } else if (op == 3) {
        h_in(sql, "SERVERMESSAGEID", h_match(match, 3), 0);
        if (!special) g_string_append(sql->text, " AND ISDELETE!=1");
    } else if (op == 4) {
        h_equal(sql, "CLIENTMESSAGEID", h_match(match, 4));
        g_string_append(sql->text, " AND ISDELETE!=1");
    } else if (op == 40) {
        h_equal(sql, "RECEIPTSTATE", h_match(match, 40));
    } else if (op == 61) {
        J *ids = h_match(match, 61);
        if (!json_object_is_type(ids, json_type_array)) return SQLITE_MISMATCH;
        J *local_ids = json_object_new_array();
        int rc = SQLITE_OK;
        for (size_t i = 0; i < json_object_array_length(ids); ++i) {
            int64_t id;
            unsigned number;
            rc = h_record_id(json_object_array_get_idx(ids, i), &id, &number);
            if (rc) break;
            if (number == database_number) json_object_array_add(local_ids, json_object_new_int64(id));
        }
        if (!rc) h_in(sql, "RECORD_ID", local_ids, 0);
        json_object_put(local_ids);
        if (rc) return rc;
    } else if (op == 1 || op == 2) {
        if (op == 1 && *h_text(h_match(match, 1))) h_equal(sql, "CONVERSATION_ID", h_match(match, 1));
        if (op == 2 && h_int(h_match(match, 2), 0) > 0) h_equal(sql, "CONVERSATION_AUTOID", h_match(match, 2));
        if (!special) {
            if (h_match(match, 19) && *h_text(h_match(match, 19)))
                h_in(sql, "MEDIATYPE", h_match(match, 19), 0);
            if (h_int(h_match(match, 41), 0) > 0)
                g_string_append(sql->text, " AND (ISWITHDRAW!=1 OR ISWITHDRAW IS NULL) AND MEDIATYPE!=16");
            if (h_int(h_match(match, 18), -1) >= 0) h_equal(sql, "ISREAD", h_match(match, 18));
            if (*h_text(h_match(match, 9)))
                g_string_append(sql->text, " AND FILELIST!='' AND MEDIATYPE IN (1,2,3,4,10)");
            h_optional_compare(sql, "UTCSTAMP", ascending ? "<=" : ">=", h_match(match, 66));
        }
        h_optional_compare(sql, "UTCSTAMP", ascending ? ">=" : "<=", h_match(match, 24));
        if (!special) g_string_append(sql->text, " AND ISDELETE!=1");
    } else if (op == 17) {
        g_string_append(sql->text, " AND ISDELETE!=1 AND (ISWITHDRAW!=1 OR ISWITHDRAW IS NULL) AND RECORDTYPE IN(0,1)");
        if (*h_text(h_match(match, 1))) h_equal(sql, "CONVERSATION_ID", h_match(match, 1));
        else if (h_int(h_match(match, 2), 0) > 0) h_equal(sql, "CONVERSATION_AUTOID", h_match(match, 2));
        if (*h_text(h_match(match, 19))) h_in(sql, "MEDIATYPE", h_match(match, 19), 0);
        h_like(sql, "SHOWTEXT", h_match(match, 17));
        h_optional_compare(sql, "UTCSTAMP", ">=", h_match(match, 24));
        h_optional_compare(sql, "UTCSTAMP", "<=", h_match(match, 63));
    } else if (op == 42 || op == 43) {
        g_string_append(sql->text, " AND ISDELETE!=1 AND (ISWITHDRAW!=1 OR ISWITHDRAW IS NULL)");
        J *conversations = h_match(match, 1);
        if (op == 42 && *h_text(conversations)) h_equal(sql, "CONVERSATION_ID", conversations);
        else if (op == 43 && h_length(conversations))
            h_in(sql, "CONVERSATION_ID", conversations, 0);
        if (op == 43 && h_length(h_match(match, 64)))
            h_in(sql, "CONVERSATION_ID", h_match(match, 64), 1);
        if (*h_text(h_match(match, 19))) h_in(sql, "MEDIATYPE", h_match(match, 19), 0);
        h_optional_compare(sql, op == 42 ? "CAST(UTCSTAMP AS INTEGER)" : "UTCSTAMP", ">=", h_match(match, 24));
        h_optional_compare(sql, op == 42 ? "CAST(UTCSTAMP AS INTEGER)" : "UTCSTAMP", "<=", h_match(match, 23));
        if (h_length(h_match(match, 14))) h_in(sql, "ORIGINACCOUNT", h_match(match, 14), 0);
        if (*h_text(h_match(match, 13))) {
            const char *name = h_text(h_match(match, 13));
            char *pattern = g_strconcat("%", name, "%", NULL);
            g_string_append(sql->text, " AND (replace(LOWER(PEERNAME),' ','') LIKE replace(lower(?),' ','') OR PEERNATIVENAME LIKE ? OR ORIGINACCOUNT LIKE ?)");
            for (int i = 0; i < 3; ++i) json_object_array_add(sql->values, json_object_new_string(pattern));
            g_free(pattern);
        }
        if (op == 43 && h_length(h_match(match, 43))) {
            g_string_append(sql->text, " AND (");
            if (h_length(h_match(match, 17))) {
                g_string_append(sql->text, "(1=1");
                h_words(sql, "SHOWTEXT", h_match(match, 17));
                g_string_append(sql->text, ") OR ");
            }
            /* Preserve the original SQL precedence of this legacy predicate. */
            g_string_append(sql->text, "(MEDIATYPE=4 OR MEDIATYPE=10");
            h_words(sql, "SHOWTEXT", h_match(match, 43));
            g_string_append(sql->text, "))");
        } else h_words(sql, "SHOWTEXT", h_match(match, 17));
    } else if (op == 44) {
        J *accounts = h_match(match, 14), *names = h_match(match, 13);
        size_t account_count = h_length(accounts);
        size_t name_count = h_length(names);
        if (!account_count && !name_count) return SQLITE_MISMATCH;
        g_string_append(sql->text, " AND CONVERSATION_ID IN (");
        for (size_t i = 0; i < account_count + name_count; ++i) {
            if (i) g_string_append(sql->text, " INTERSECT ");
            g_string_append(sql->text, "SELECT CONVERSATION_ID FROM RecordTab WHERE 1=1");
            if (i < account_count) h_equal(sql, "ORIGINACCOUNT", json_object_array_get_idx(accounts, i));
            else {
                struct history_sql like = h_sql("");
                J *word = json_object_array_get_idx(names, i - account_count);
                h_like(&like, "PEERNATIVENAME", word);
                g_string_append(sql->text, " AND (");
                g_string_append(sql->text, like.text->str + 5);
                h_value(sql, json_object_array_get_idx(like.values, 0));
                g_string_truncate(like.text, 0);
                h_like(&like, "PEERNAME", word);
                g_string_append(sql->text, " OR ");
                g_string_append(sql->text, like.text->str + 5);
                h_value(sql, json_object_array_get_idx(like.values, 1));
                g_string_append_c(sql->text, ')');
                h_sql_free(&like);
            }
        }
        g_string_append_c(sql->text, ')');
    } else if (op == 67) {
        g_string_append(sql->text, " AND ISDELETE!=1 AND ISWITHDRAW!=1 AND MEDIATYPE IN(2,4,10) AND FILELIST!=''");
        h_in(sql, "SHOWTEXT", h_match(match, 9), 0);
    } else if (op == 38) {
        g_string_append(sql->text, " AND ISDELETE!=1");
    } else return SQLITE_MISMATCH;
    if (h_length(h_match(match, 65)))
        h_in(sql, "SERVERMESSAGEID", h_match(match, 65), 1);
    return sql->error;
}

static int h_rows_ascending(const void *a, const void *b)
{
    J *left = *(J *const *)a, *right = *(J *const *)b;
    int cmp = strcmp(native_string(left, "utcstamp", ""), native_string(right, "utcstamp", ""));
    if (!cmp) cmp = strcmp(native_string(left, "servermessageid", ""), native_string(right, "servermessageid", ""));
    return cmp;
}

static int h_rows_descending(const void *a, const void *b)
{
    return h_rows_ascending(b, a);
}

static int h_groups_named(struct im_db_context *ctx, J *name, J **groups)
{
    struct history_sql sql = h_sql("SELECT GROUPID FROM GroupTab WHERE ");
    struct history_sql names = h_sql("1=1"), english = h_sql("1=1");
    h_words(&names, "NAME", name);
    h_words(&english, "ENNAME", name);
    g_string_append_printf(sql.text, "(%s) OR (%s)", names.text->str, english.text->str);
    for (size_t i = 0; i < json_object_array_length(names.values); ++i)
        h_value(&sql, json_object_array_get_idx(names.values, i));
    for (size_t i = 0; i < json_object_array_length(english.values); ++i)
        h_value(&sql, json_object_array_get_idx(english.values, i));
    h_sql_free(&names);
    h_sql_free(&english);
    sqlite3_stmt *stmt = NULL;
    int rc = h_prepare(im_db_database(ctx, "userdb"), &sql, &stmt);
    *groups = json_object_new_array();
    if (!rc) {
        while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
            const char *id = (const char *)sqlite3_column_text(stmt, 0);
            json_object_array_add(*groups, json_object_new_string(id ? id : ""));
        }
        if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    sqlite3_finalize(stmt);
    h_sql_free(&sql);
    return rc;
}

static int h_history_query(struct im_db_context *ctx, J *param, int special, J **result)
{
    J *match;
    int op, rc = h_multi(param, &match, &op);
    if (rc) return rc;
    int type = (int)native_integer(match, "specialmsgtype", 0);
    if (special && (type < 1 || type > 3)) return SQLITE_MISMATCH;
    if (!special) rc = h_history_ready(ctx);
    if (rc) return rc;
    const struct history_table *table = &tables[special ? H_OFFICIAL + type - 1 : H_RECORD];
    int sorted = op == 1 || op == 2 || op == 17 || op == 42 || op == 43;
    int ascending = (op == 1 || op == 2 || op == 43) && h_int(h_match(match, 27), 0) != 0;
    int64_t limit = sorted ? h_int(h_match(match, 25), 0) : 0;
    int64_t offset = op == 42 || op == 43 ? h_int(h_match(match, 26), 0) : 0;
    if (offset < 0) offset = 0;
    GPtrArray *databases = NULL;
    rc = special ? SQLITE_OK : h_databases(ctx, &databases);
    J *rows = json_object_new_array();
    guint n = special ? 1 : databases->len;
    J *group_ids = NULL;
    if (!rc && op == 43 && (*h_text(h_match(match, 11)) || h_length(h_match(match, 11))))
        rc = h_groups_named(ctx, h_match(match, 11), &group_ids);
    for (guint i = 0; !rc && i < n; ++i) {
        struct history_database *entry = special ? NULL : g_ptr_array_index(databases, i);
        if (entry) rc = h_open(ctx, entry);
        struct history_sql sql = h_select(table);
        if (!rc) rc = h_record_filter(&sql, match, op, entry ? entry->number : 0, special);
        if (group_ids) h_in(&sql, "GROUPID", group_ids, 0);
        if (sorted) {
            g_string_append(sql.text, ascending ? " ORDER BY UTCSTAMP ASC,SERVERMESSAGEID ASC" :
                                                   " ORDER BY UTCSTAMP DESC,SERVERMESSAGEID DESC");
            if (limit > 0 && offset <= INT64_MAX - limit) h_limit(&sql, limit + offset, 0);
        } else if (op == 44) g_string_append(sql.text, " GROUP BY CONVERSATION_ID");
        if (!rc) rc = h_query(entry ? entry->db : im_db_database(ctx, "specialMsgdb"),
                              &sql, table, entry ? entry->number : 0, rows);
        h_sql_free(&sql);
    }
    json_object_put(group_ids);
    if (databases) g_ptr_array_free(databases, TRUE);
    if (!rc && sorted) {
        json_object_array_sort(rows, ascending ? h_rows_ascending : h_rows_descending);
        size_t length = json_object_array_length(rows);
        size_t skip = (uint64_t)offset < length ? (size_t)offset : length;
        if (skip) json_object_array_del_idx(rows, 0, skip);
        length = json_object_array_length(rows);
        if (limit > 0 && (uint64_t)limit < length)
            json_object_array_del_idx(rows, (size_t)limit, length - (size_t)limit);
    }
    if (!rc && op == 44) {
        J *conversations = json_object_new_array();
        GHashTable *seen = g_hash_table_new(g_str_hash, g_str_equal);
        for (size_t i = 0; i < json_object_array_length(rows); ++i) {
            J *row = json_object_array_get_idx(rows, i);
            J *conversation = native_get(row, "convid");
            const char *id = h_text(conversation);
            if (g_hash_table_contains(seen, id)) continue;
            g_hash_table_add(seen, (gpointer)id);
            J *item = json_object_new_object();
            for (size_t j = 0; j < table->count; ++j) {
                const struct history_field *field = &table->fields[j];
                if (!strcmp(field->column, "UTCDATE")) continue;
                J *value = field->string_value ? json_object_new_string("") : json_object_new_int(field->initial);
                json_object_object_add(item, field->key, value);
            }
            json_object_object_add(item, "recordid", json_object_new_string("-1#0"));
            json_object_object_add(item, "convid", json_object_get(conversation));
            json_object_array_add(conversations, item);
        }
        g_hash_table_destroy(seen);
        json_object_put(rows);
        rows = conversations;
    }
    if (!rc) *result = h_list_result("_historyrecordlist", "_retlen", rows);
    else json_object_put(rows);
    return rc;
}

static int h_history_count(struct im_db_context *ctx, J **result)
{
    int rc = h_history_ready(ctx);
    if (rc) return rc;
    GPtrArray *databases = NULL;
    rc = h_databases(ctx, &databases);
    int64_t total = 0;
    for (guint i = 0; !rc && i < databases->len; ++i) {
        struct history_database *entry = g_ptr_array_index(databases, i);
        rc = h_open(ctx, entry);
        sqlite3_stmt *stmt = NULL;
        if (!rc) rc = sqlite3_prepare_v2(entry->db, "SELECT COUNT(*) FROM RecordTab", -1, &stmt, NULL);
        if (!rc) {
            rc = sqlite3_step(stmt);
            if (rc == SQLITE_ROW) { total += sqlite3_column_int64(stmt, 0); rc = SQLITE_OK; }
        }
        sqlite3_finalize(stmt);
    }
    g_ptr_array_free(databases, TRUE);
    if (!rc) {
        *result = json_object_new_object();
        json_object_object_add(*result, "_historyCount", json_object_new_int64(total));
    }
    return rc;
}

static int h_user_setting(struct im_db_context *ctx, const char *key, const char *value)
{
    struct history_sql sql = h_sql(
        "INSERT OR REPLACE INTO UserConfigTab(AUTOID,KEY,VALUE)"
        " VALUES((SELECT AUTOID FROM UserConfigTab WHERE KEY=? LIMIT 1),?,?)");
    json_object_array_add(sql.values, json_object_new_string(key));
    json_object_array_add(sql.values, json_object_new_string(key));
    json_object_array_add(sql.values, json_object_new_string(value));
    int rc = h_run(im_db_database(ctx, "userdb"), &sql);
    h_sql_free(&sql);
    return rc;
}

static int h_cleanup(struct im_db_context *ctx, J *param)
{
    int64_t days = native_integer(param, "days", -1);
    if (days < 0 || days > INT_MAX) return SQLITE_MISMATCH;
    int rc = days ? h_history_ready(ctx) : SQLITE_OK;
    if (rc) return rc;
    char period[32];
    snprintf(period, sizeof period, "%" PRId64, days);
    rc = h_user_setting(ctx, "HistoryPeriod", period);
    if (rc || !days) return rc;
    GDateTime *now = g_date_time_new_now_local();
    GDateTime *start = g_date_time_new_from_unix_local(g_date_time_to_unix(now) - days * INT64_C(86400));
    if (!start) { g_date_time_unref(now); return SQLITE_RANGE; }
    char *date = g_date_time_format(start, "%Y-%m-%d");
    char *today = g_date_time_format(now, "%Y-%m-%d");
    GDateTime *midnight = g_date_time_new_local(g_date_time_get_year(start),
        g_date_time_get_month(start), g_date_time_get_day_of_month(start), 0, 0, 0);
    if (!midnight) {
        g_free(date);
        g_free(today);
        g_date_time_unref(start);
        g_date_time_unref(now);
        return SQLITE_RANGE;
    }
    char stamp[32];
    snprintf(stamp, sizeof stamp, "%" PRId64, (int64_t)g_date_time_to_unix(midnight) * 1000);
    rc = h_user_setting(ctx, "HistoryStartDate", date);
    GPtrArray *databases = NULL;
    if (!rc) rc = h_databases(ctx, &databases);
    for (guint i = 0; !rc && i < databases->len; ++i) {
        struct history_database *entry = g_ptr_array_index(databases, i);
        rc = h_open(ctx, entry);
        struct history_sql sql = h_sql("DELETE FROM RecordTab WHERE UTCSTAMP<?");
        json_object_array_add(sql.values, json_object_new_string(stamp));
        if (!rc) rc = h_run(entry->db, &sql);
        h_sql_free(&sql);
    }
    if (!rc) rc = h_user_setting(ctx, "DelHisSuccessDate", today);
    if (databases) g_ptr_array_free(databases, TRUE);
    g_date_time_unref(midnight);
    g_date_time_unref(start);
    g_date_time_unref(now);
    g_free(date);
    g_free(today);
    return rc;
}

static int h_reload(struct im_db_context *ctx)
{
    int rc = h_history_ready(ctx);
    if (rc) return rc;
    GPtrArray *databases = NULL;
    rc = h_databases(ctx, &databases);
    for (guint i = 0; !rc && i < databases->len; ++i) {
        struct history_database *entry = g_ptr_array_index(databases, i);
        rc = h_open(ctx, entry);
        if (!rc) rc = h_history_schema(entry->db);
    }
    g_ptr_array_free(databases, TRUE);
    return rc;
}

/* Read-only GroupTab view for command 122; the entity slice owns its schema. */
static const struct history_field group_result_fields[] = {
    {"AUTOID", "id", NULL, 0, 0},
    {"GROUPID", "groupid", NULL, 1, 0},
    {"GROUP_GROUPID", "group_groupid", NULL, 1, 0},
    {"CAPACITY", "capacity", NULL, 0, 0},
    {"NAME", "name", NULL, 1, 0},
    {"ENNAME", "enname", NULL, 1, 0},
    {"OWNER", "owner", NULL, 1, 0},
    {"DESC", "desc", NULL, 1, 0},
    {"GROUPTYPE", "grouptype", NULL, 0, 0},
    {"JOINFLAG", "joinflag", NULL, 0, 0},
    {"MANIFESTO", "manifesto", NULL, 1, 0},
    {"MSGPOLICYTYPE", "msgpolicytype", NULL, 0, 0},
    {"STATE", "state", NULL, 0, 0},
    {"SETTOP", "settop", NULL, 0, 0},
    {"ORDERBY", "orderby", NULL, 0, 0},
    {"TIMESTAMP", "timestamp", NULL, 1, 0},
    {"ISFIXED", "isfixed", NULL, 0, 0},
    {"EXPARAMS", "exparams", NULL, 1, 0},
    {"SINGLEFILESPACE", "singlefilespace", NULL, 0, 0},
    {"GROUPSPACEID", "groupspaceid", NULL, 1, 0},
    {"GROUPSPACENAME", "groupspacename", NULL, 1, 0},
    {"ISINITGROUPNAME", "isinitgroupname", NULL, 0, 0},
    {"SYNCMEMBERTIME2", "syncmembertime", NULL, 1, 0},
    {"SINGLEFILESPACESTR", "singlefilespacestr", NULL, 1, 0},
    {"TEAMNOTIFYISREAD", "teamnotifyisread", NULL, 0, 0},
    {"TENANTID", "tenantId", NULL, 1, 0},
    {"CROSSCROPGROUP", "crossCorpGroup", NULL, 0, 0},
    {"GROUPEXTDATA", "groupExtData", NULL, 1, 0},
    {"ISGROUPDISABLESENDMSG", "isGroupDisableSendMsg", NULL, 0, 0},
    {"ENABLEEXTERNALDISPLAY", "enableExternalDisplay", NULL, 0, 0},
    {"SHOWHISMSGPOLICY", "showHisMsgPolicy", NULL, 0, 0},
    {"DEFAULTICONLIST", "defaultIconList", NULL, 1, 0},
    {"GROUPICON", "groupIcon", NULL, 1, 0},
    {"MARKSTATE", "markState", NULL, 0, 0}
};
static const struct history_table group_result_table = {
    "GroupTab", "userdb", group_result_fields, HCOUNT(group_result_fields)
};

struct history_group_result {
    J *row;
    int64_t recent;
};

static int h_group_recent_order(gconstpointer a, gconstpointer b)
{
    const struct history_group_result *left = a, *right = b;
    return left->recent < right->recent ? 1 : left->recent > right->recent ? -1 : 0;
}

static int h_group_search(struct im_db_context *ctx, J *param, J **result)
{
    J *keywords = native_get(param, "keywordList");
    int64_t length = native_integer(param, "keywordListLength", -1);
    int64_t maximum = native_integer(param, "maxLength", -1);
    if (length < 1 || maximum < 0 || !json_object_is_type(keywords, json_type_array) ||
        (uint64_t)length != json_object_array_length(keywords)) return SQLITE_MISMATCH;
    struct history_sql sql = h_select(&group_result_table);
    /* Each word may match either the group name or a member. Independent EXISTS
     * clauses deliberately allow different members to match different words. */
    for (int64_t i = 0; i < length; ++i) {
        J *word = json_object_array_get_idx(keywords, (size_t)i);
        if (!json_object_is_type(word, json_type_string) || !*h_text(word)) {
            sql.error = SQLITE_MISMATCH;
            break;
        }
        struct history_sql pattern = h_sql("");
        h_like(&pattern, "NAME", word);
        J *like = json_object_array_get_idx(pattern.values, 0);
        g_string_append(sql.text,
            " AND (NAME LIKE ? ESCAPE '/' OR ENNAME LIKE ? ESCAPE '/'"
            " OR EXISTS(SELECT 1 FROM UniGroupMemberTab m WHERE m.GROUPID=GroupTab.GROUPID"
            " AND (m.MEMBERNAME LIKE ? ESCAPE '/' OR m.QPINYIN LIKE ? ESCAPE '/' OR m.ACCOUNT LIKE ? ESCAPE '/')))");
        for (int j = 0; j < 5; ++j) h_value(&sql, like);
        h_sql_free(&pattern);
    }
    sqlite3_stmt *stmt = NULL, *recent = NULL;
    int rc = h_prepare(im_db_database(ctx, "userdb"), &sql, &stmt);
    sqlite3 *conversation_db = im_db_database(ctx, "conversationdb");
    if (!rc) rc = conversation_db ? sqlite3_prepare_v2(conversation_db,
        "SELECT RECEIVERLASTMARKTIME FROM ConversationTab WHERE GROUPID=? ORDER BY RECEIVERLASTMARKTIME DESC LIMIT 1",
        -1, &recent, NULL) : SQLITE_CANTOPEN;
    GArray *found = g_array_new(FALSE, FALSE, sizeof(struct history_group_result));
    if (!rc) {
        while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
            struct history_group_result entry = {h_row(stmt, &group_result_table, 0), 0};
            const char *id = (const char *)sqlite3_column_text(stmt, 1);
            int query = sqlite3_bind_text(recent, 1, id ? id : "", -1, SQLITE_TRANSIENT);
            if (!query) {
                query = sqlite3_step(recent);
                if (query == SQLITE_ROW) { entry.recent = sqlite3_column_int64(recent, 0); query = SQLITE_OK; }
                else if (query == SQLITE_DONE) query = SQLITE_OK;
            }
            sqlite3_reset(recent);
            sqlite3_clear_bindings(recent);
            g_array_append_val(found, entry);
            if (query) { rc = query; break; }
        }
        if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    sqlite3_finalize(recent);
    sqlite3_finalize(stmt);
    h_sql_free(&sql);
    g_array_sort(found, h_group_recent_order);
    J *rows = json_object_new_array();
    for (guint i = 0; i < found->len; ++i) {
        J *row = g_array_index(found, struct history_group_result, i).row;
        if (!rc && (uint64_t)i < (uint64_t)maximum) json_object_array_add(rows, row);
        else json_object_put(row);
    }
    g_array_free(found, TRUE);
    if (!rc) *result = h_list_result("_groupinfolist", "_retlen", rows);
    else json_object_put(rows);
    return rc;
}

static gint h_font_order(gconstpointer a, gconstpointer b)
{
    const char *left = *(char *const *)a, *right = *(char *const *)b;
    int latin_left = g_ascii_isalpha((guchar)*left), latin_right = g_ascii_isalpha((guchar)*right);
    if (latin_left != latin_right) return latin_left ? 1 : -1;
    return strcmp(left, right);
}

static int h_fonts(J **result)
{
    /* Fontconfig is the native counterpart of EnumFontFamiliesW. It enumerates
     * installed families; nothing is fabricated when enumeration is unavailable. */
    char *argv[] = {"fc-list", "--format", "%{family[0]}\n", NULL};
    char *output = NULL;
    gint status = 0;
    GError *error = NULL;
    gboolean ok = g_spawn_sync(NULL, argv, NULL, G_SPAWN_SEARCH_PATH, NULL, NULL,
                               &output, NULL, &status, &error);
    if (ok) ok = g_spawn_check_wait_status(status, &error);
    g_clear_error(&error);
    if (!ok) { g_free(output); return SQLITE_ERROR; }
    char **lines = g_strsplit(output ? output : "", "\n", -1);
    GPtrArray *names = g_ptr_array_new();
    for (size_t i = 0; lines[i]; ++i)
        if (*lines[i] && lines[i][0] != '@' && g_utf8_validate(lines[i], -1, NULL))
            g_ptr_array_add(names, lines[i]);
    g_ptr_array_sort(names, h_font_order);
    J *body = json_object_new_array();
    const char *previous = NULL;
    for (guint i = 0; i < names->len; ++i) {
        const char *name = g_ptr_array_index(names, i);
        if (!previous || strcmp(previous, name)) json_object_array_add(body, json_object_new_string(name));
        previous = name;
    }
    *result = json_object_new_object();
    if (json_object_array_length(body)) json_object_object_add(*result, "body", body);
    else json_object_put(body);
    g_ptr_array_free(names, TRUE);
    g_strfreev(lines);
    g_free(output);
    return SQLITE_OK;
}

/* The original GroupChatLimit is an in-memory queue, not a disk-space quota.
 * A queue needs at most ten timestamps, so use an inline ring rather than one
 * allocation for every message. The service serializes access to this slice. */
struct history_rate {
    int64_t timestamps[10];
    unsigned first, count;
};
static GHashTable *history_rates;
static char *history_rate_directory;

/* The service has one active, serialized database worker. Clear session-only
 * limiter state before account replacement or worker teardown, even when the
 * next session reuses both the context address and the account directory. */
void im_db_history_reset(struct im_db_context *ctx)
{
    (void)ctx;
    if (history_rates) g_hash_table_destroy(history_rates);
    history_rates = NULL;
    g_free(history_rate_directory);
    history_rate_directory = NULL;
}

static int h_rate_limit(struct im_db_context *ctx, J *param, J **result)
{
    J *stamp_value = native_get(param, "currentTimestamp");
    J *messages = native_get(param, "msgList");
    int64_t stamp = h_int(stamp_value, INT64_MIN);
    if (!json_object_is_type(stamp_value, json_type_string) || stamp == INT64_MIN ||
        !json_object_is_type(messages, json_type_array)) return SQLITE_MISMATCH;
    const char *directory = im_db_directory(ctx);
    if (!history_rates || g_strcmp0(directory, history_rate_directory)) {
        im_db_history_reset(ctx);
        history_rate_directory = g_strdup(directory);
        history_rates = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
    }
    J *list = json_object_new_array();
    for (size_t i = 0; i < json_object_array_length(messages); ++i) {
        J *message = json_object_array_get_idx(messages, i);
        const char *group = native_string(message, "groupId", NULL);
        int64_t count = native_integer(message, "flowLimitCount", -1);
        if (!group || !*group || count < 0) { json_object_put(list); return SQLITE_MISMATCH; }
        int send = 1;
        if (count <= 10) {
            unsigned maximum = count <= 5 ? 5 : 10;
            struct history_rate *rate = g_hash_table_lookup(history_rates, group);
            if (!rate) {
                rate = g_new0(struct history_rate, 1);
                g_hash_table_insert(history_rates, g_strdup(group), rate);
            }
            while (rate->count && stamp >= rate->timestamps[rate->first] &&
                   (uint64_t)stamp - (uint64_t)rate->timestamps[rate->first] >= 60000) {
                rate->first = (rate->first + 1) % HCOUNT(rate->timestamps);
                --rate->count;
            }
            send = rate->count < maximum;
            if (send) {
                rate->timestamps[(rate->first + rate->count) % HCOUNT(rate->timestamps)] = stamp;
                ++rate->count;
            }
        }
        J *item = json_object_new_object();
        json_object_object_add(item, "groupId", json_object_new_string(group));
        json_object_object_add(item, "flowLimitCount", json_object_new_int64(count));
        json_object_object_add(item, "isSendMsg", json_object_new_boolean(send));
        json_object_array_add(list, item);
    }
    *result = json_object_new_object();
    json_object_object_add(*result, "currentTimestamp", json_object_get(stamp_value));
    if (json_object_array_length(list)) json_object_object_add(*result, "msgList", list);
    else {
        json_object_put(list);
        json_object_object_add(*result, "msgList", NULL);
    }
    return SQLITE_OK;
}

int im_db_history(struct im_db_context *context, const struct native_request *request,
                  struct json_object **reply)
{
    int command = (int)(request->cmd & 0x2ffff);
    J *param = NULL;
    const char *description = NULL;
    int rc = SQLITE_OK;
    int64_t inserted = 0;
    switch (command) {
    case 41: description = "tup_sqlite_add_conversation"; rc = h_add(context, H_CONVERSATION, request->param, "_cvsinfo", NULL, NULL, &inserted); break;
    case 42: description = "tup_sqlite_add_conversationlist"; rc = h_add(context, H_CONVERSATION, request->param, NULL, "_cvsinfolist", "_arraylen", NULL); break;
    case 43: description = "tup_sqlite_delete_conversation"; rc = h_delete(context, H_CONVERSATION, request->param); break;
    case 44: description = "tup_sqlite_query_conversation"; rc = h_conversations(context, request->param, &param); break;
    case 45: description = "tup_sqlite_update_conversation"; rc = h_group_update(context, request->param, command); break;
    case 46: description = "tup_sqlite_add_filerecord"; rc = h_add(context, H_FILE, request->param, "_filerecordinfo", NULL, NULL, &inserted); break;
    case 47: description = "tup_sqlite_add_filerecordlist"; rc = h_add(context, H_FILE, request->param, NULL, "_filerecordlist", "_arraylen", NULL); break;
    case 48: description = "tup_sqlite_delete_filerecord"; rc = h_delete(context, H_FILE, request->param); break;
    case 49: description = "tup_sqlite_query_filerecord"; rc = h_files(context, request->param, 0, &param); break;
    case 50: description = "tup_sqlite_add_screenshotfile"; rc = h_add(context, H_SCREEN, request->param, "_screenfileinfo", NULL, NULL, &inserted); break;
    case 51: description = "tup_sqlite_add_screenshotfilelist"; rc = h_add(context, H_SCREEN, request->param, NULL, "_screenfileinfolist", "_arraylen", NULL); break;
    case 52: description = "tup_sqlite_delete_screenshotfile"; rc = h_delete(context, H_SCREEN, request->param); break;
    case 53: description = "tup_sqlite_query_screenshotfile"; rc = h_files(context, request->param, 1, &param); break;
    case 54: case 55: case 118: case 131: case 132:
        description = command == 118 ? "tup_sqlite_add_historyrecordlistNotReplace" :
                      command == 54 || command == 131 ? "tup_sqlite_add_historyrecord" :
                      "tup_sqlite_add_historyrecordlist";
        rc = h_add_history(context, request->param, command, &param, &inserted);
        break;
    case 56: case 58:
        description = command == 56 ? "tup_sqlite_delete_historyrecord" : "tup_sqlite_update_historyrecord";
        rc = h_history_write(context, request->param, command);
        break;
    case 133: case 135:
        /* Both original entry points stop after validating their matches; no
         * table selector or JS caller exists. Never pretend that they mutate. */
        description = command == 133 ? "tup_sqlite_delete_historyrecord" : "tup_sqlite_update_historyrecord";
        rc = SQLITE_MISUSE;
        break;
    case 57: case 134:
        description = "tup_sqlite_query_historyrecord";
        rc = h_history_query(context, request->param, command == 134, &param);
        break;
    case 67: description = "tup_sqlite_add_usertrack"; rc = h_add(context, H_TRACK, request->param, "_usertrackinfo", NULL, NULL, &inserted); break;
    case 68: description = "tup_sqlite_add_usertracklist"; rc = h_add(context, H_TRACK, request->param, NULL, "_usertrackinfolist", "_arraylen", NULL); break;
    case 69: description = "tup_sqlite_delete_usertrack"; rc = h_delete(context, H_TRACK, request->param); break;
    case 70: description = "tup_sqlite_query_usertrack"; rc = h_tracks(context, request->param, &param); break;
    case 71: description = "tup_sqlite_add_callrecord"; rc = h_add(context, H_CALL, request->param, "_callrecordinfo", NULL, NULL, &inserted); break;
    case 72: description = "tup_sqlite_add_callrecordlist"; rc = h_add(context, H_CALL, request->param, NULL, "_callrecordinfolist", "_arraylen", NULL); break;
    case 73: description = "tup_sqlite_delete_callrecord"; rc = h_delete(context, H_CALL, request->param); break;
    case 74: description = "tup_sqlite_query_callrecord"; rc = h_calls(context, request->param, &param); break;
    case 96: description = "tup_sqlite_query_history_count"; rc = h_history_count(context, &param); break;
    case 102: description = "tup_uilogic_getsystemfont"; rc = h_fonts(&param); break;
    case 121: {
        description = "tup_sqlite_archive_switch";
        J *key = native_get(native_get(request->param, "_matchinfo"), "keytype");
        if (!json_object_is_type(key, json_type_int)) rc = SQLITE_MISMATCH;
        else {
            int enabled = json_object_get_int64(key) != 0;
            rc = im_db_archive_switch(context, enabled);
            if (!rc) {
                param = json_object_new_object();
                json_object_object_add(param, "CouldArchive", json_object_new_boolean(enabled));
            }
        }
        break;
    }
    case 122: description = "tup_sqlite_search_groupInfo_by_keyword"; rc = h_group_search(context, request->param, &param); break;
    case 123: description = "tup_sqlite_query_conversation_and_sort"; rc = h_accounts(context, request->param, 1, &param); break;
    case 129: description = "tup_sqlite_archive_notify"; rc = h_reload(context); break;
    case 141: description = "tup_sqlite_query_conversation_account"; rc = h_accounts(context, request->param, 0, &param); break;
    case 142: description = "tup_sqlite_add_conversation_group"; rc = h_add(context, H_GROUP, request->param, "conversationGroupInfo", NULL, NULL, &inserted); break;
    case 143: description = "tup_sqlite_add_conversation_group_list"; rc = h_add(context, H_GROUP, request->param, NULL, "conversationGroupInfoList", "listLen", NULL); break;
    case 144: description = "tup_sqlite_delete_conversation_group"; rc = h_delete(context, H_GROUP, request->param); break;
    case 145: description = "tup_sqlite_update_conversation_group"; rc = h_group_update(context, request->param, command); break;
    case 146: description = "tup_sqlite_update_conversation_group_idx_no"; rc = h_group_update(context, request->param, command); break;
    case 147: description = "tup_sqlite_query_conversation_group"; rc = h_groups(context, request->param, 0, 0, &param); break;
    case 148: description = "tup_sqlite_add_conversation_group_member"; rc = h_add(context, H_MEMBER, request->param, "conversationGroupMemberInfo", NULL, NULL, &inserted); break;
    case 149: description = "tup_sqlite_add_conversation_group_member_list"; rc = h_add(context, H_MEMBER, request->param, NULL, "conversationGroupMemberInfoList", "listLen", NULL); break;
    case 150: description = "tup_sqlite_delete_conversation_group_member"; rc = h_group_update(context, request->param, command); break;
    case 151: description = "tup_sqlite_query_conversation_group_member"; rc = h_groups(context, request->param, 1, 0, &param); break;
    case 152: description = "tup_sqlite_query_conversation_group_member_detail_info"; rc = h_groups(context, request->param, 1, 1, &param); break;
    case 153: description = "tup_sqlite_delete_history_days_ago"; rc = h_cleanup(context, request->param); break;
    case 154: description = "tup_sqlite_check_is_exceed_limit"; rc = h_rate_limit(context, request->param, &param); break;
    default: return 0;
    }
    int result = rc ? -1 : (int)inserted;
    if (!rc && (command == 42 || command == 47 || command == 51 ||
                command == 68 || command == 72 || command == 143 || command == 149 ||
                command == 43 || command == 45 || command == 48 || command == 52 ||
                command == 56 || command == 58 || command == 69 || command == 73 ||
                command == 144 || command == 145 || command == 146 || command == 150 ||
                command == 57 || command == 134))
        result = 1;
    if (!rc && command == 131) result = inserted > 0 ? 1 : 0;
    if (!rc && (command == 42 || command == 143 || command == 149) &&
        native_integer(request->param, command == 42 ? "_arraylen" : "listLen", -1) == 0)
        result = 0;
    if (!rc && (command == 49 || command == 53 || command == 70 || command == 74 ||
                command == 147 || command == 151 || command == 152))
        result = native_integer(param, command == 147 || command == 151 ? "listLen" : "_retlen", 0) > 0;
    if (!rc && command == 70 && native_integer(native_get(request->param, "_matchinfo"), "keytype", -1) == 5)
        result = 1;
    if (!rc && command == 146 && native_integer(request->param, "listLen", -1) == 0) result = 0;
    if (rc) {
        json_object_put(param);
        param = json_object_new_object();
        json_object_object_add(param, "reason", json_object_new_string(
            rc == SQLITE_MISMATCH ? "param is not correct!" :
            command == 133 || command == 135 ? "original special-message entry point has no mutation protocol" :
            sqlite3_errstr(rc)));
    } else if (command == 153) result = 1;
    *reply = im_db_reply(request, result, param, description);
    return 1;
}

/* ArchivingManager (plugin 0x21bf0/0x22c00/0x23090) checks byte size on a
 * configurable timer, initially disabled. OVER_THE_DAYS_TO_ARCHIVE is read and
 * logged by that DLL but is not a trigger. Keep that distinction here. */
struct history_archive_options {
    unsigned interval;
    uint64_t bytes;
    int enabled, started;
    char *timestamp;
};

static int h_archive_options(struct im_db_context *ctx, struct history_archive_options *options,
                              int include_configuration)
{
    *options = (struct history_archive_options){1800000, UINT64_C(524288000), 0, 0, NULL};
    static const char *const files[] = {"UserConfig.ini", "ArchiveConfig.ini"};
    for (size_t i = 0; i < (include_configuration ? HCOUNT(files) : 1); ++i) {
        char *path = g_build_filename(im_db_directory(ctx), files[i], NULL);
        char *contents = NULL;
        GError *error = NULL;
        gboolean ok = g_file_get_contents(path, &contents, NULL, &error);
        g_free(path);
        if (!ok) {
            int missing = g_error_matches(error, G_FILE_ERROR, G_FILE_ERROR_NOENT);
            g_clear_error(&error);
            if (!missing) return SQLITE_IOERR_READ;
            continue;
        }
        char **lines = g_strsplit(contents, "\n", -1);
        for (size_t j = 0; lines[j]; ++j) {
            char *line = g_strstrip(lines[j]);
            if (!*line || g_str_has_prefix(line, "//")) continue;
            char *equals = strchr(line, '=');
            if (!equals) continue;
            *equals++ = 0;
            char *key = g_strstrip(line), *value = g_strstrip(equals);
            if (!strcmp(key, "ARCHIVE_SWITCH")) {
                if (!strcmp(value, "ON")) options->enabled = 1;
                else if (!strcmp(value, "OFF")) options->enabled = 0;
            } else if (!strcmp(key, "TimeStamp")) {
                g_free(options->timestamp);
                options->timestamp = g_strdup(value);
            } else {
                char *end = NULL;
                errno = 0;
                gint64 number = g_ascii_strtoll(value, &end, 10);
                if (errno || end == value || *end) continue;
                if (!strcmp(key, "ARCHIVE_CHECK_INTERVAL") && number > 0 && number <= UINT_MAX / 1000)
                    options->interval = (unsigned)number * 1000;
                else if (!strcmp(key, "OVER_THE_SIZE_TO_ARCHIVE") && number > 499 && number <= UINT_MAX / 1024)
                    options->bytes = (uint64_t)number * 1024;
                else if (!strcmp(key, "ArchiveStart")) options->started = number != 0;
            }
        }
        g_strfreev(lines);
        g_free(contents);
    }
    return SQLITE_OK;
}

static int h_file_write(const char *path, const char *contents, size_t length)
{
    GError *error = NULL;
    gboolean ok = g_file_set_contents_full(path, contents, (gssize)length,
        G_FILE_SET_CONTENTS_CONSISTENT | G_FILE_SET_CONTENTS_DURABLE, 0600, &error);
    g_clear_error(&error);
    return ok ? SQLITE_OK : SQLITE_IOERR_WRITE;
}

static int h_archive_state(struct im_db_context *ctx, const char *stamp, int started, int success)
{
    char *path = g_build_filename(im_db_directory(ctx), "UserConfig.ini", NULL);
    char *contents = NULL;
    GError *error = NULL;
    if (!g_file_get_contents(path, &contents, NULL, &error) &&
        !g_error_matches(error, G_FILE_ERROR, G_FILE_ERROR_NOENT)) {
        g_clear_error(&error);
        g_free(path);
        return SQLITE_IOERR_READ;
    }
    g_clear_error(&error);
    GString *next = g_string_new(NULL);
    char **lines = g_strsplit(contents ? contents : "", "\n", -1);
    for (size_t i = 0; lines[i]; ++i) {
        char *line = g_strstrip(lines[i]);
        if (!*line || g_str_has_prefix(line, "ArchiveStart=") ||
            g_str_has_prefix(line, "ArchiveSuccess=") || g_str_has_prefix(line, "TimeStamp="))
            continue;
        g_string_append_printf(next, "%s\n", line);
    }
    g_string_append_printf(next, "ArchiveStart=%d\nTimeStamp=%s\nArchiveSuccess=%d\n",
                           started, stamp ? stamp : "", success);
    int rc = h_file_write(path, next->str, next->len);
    g_strfreev(lines);
    g_string_free(next, TRUE);
    g_free(contents);
    g_free(path);
    return rc;
}

/* Snapshot the original private-key envelope verbatim. Database snapshots use
 * SQLite's backup API below, so a live WAL is included without copying files. */
static int h_file_copy(const char *source, const char *destination)
{
    int input = open(source, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (input < 0) return SQLITE_IOERR_READ;
    int output = open(destination, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (output < 0) { close(input); return SQLITE_IOERR_WRITE; }
    char buffer[65536];
    int rc = SQLITE_OK;
    for (;;) {
        ssize_t n = read(input, buffer, sizeof buffer);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { rc = SQLITE_IOERR_READ; break; }
        if (!n) break;
        ssize_t done = 0;
        while (done < n) {
            ssize_t written = write(output, buffer + done, (size_t)(n - done));
            if (written < 0 && errno == EINTR) continue;
            if (written <= 0) { rc = SQLITE_IOERR_WRITE; break; }
            done += written;
        }
        if (rc) break;
    }
    if (!rc && fsync(output)) rc = SQLITE_IOERR_FSYNC;
    if (close(output) && !rc) rc = SQLITE_IOERR_CLOSE;
    if (close(input) && !rc) rc = SQLITE_IOERR_CLOSE;
    if (rc) unlink(destination);
    return rc;
}

static int h_backup(sqlite3 *destination, sqlite3 *source)
{
    if (!destination || !source) return SQLITE_CANTOPEN;
    sqlite3_backup *backup = sqlite3_backup_init(destination, "main", source, "main");
    if (!backup) return sqlite3_errcode(destination);
    int rc = sqlite3_backup_step(backup, -1);
    int end = sqlite3_backup_finish(backup);
    return rc == SQLITE_DONE ? end : rc;
}

static int h_archive_copy_table(sqlite3 *destination, sqlite3 *source, const char *table)
{
    char *select = sqlite3_mprintf("SELECT * FROM \"%w\"", table);
    sqlite3_stmt *rows = NULL, *insert = NULL;
    int rc = select ? sqlite3_prepare_v2(source, select, -1, &rows, NULL) : SQLITE_NOMEM;
    sqlite3_free(select);
    if (rc) return rc;
    int columns = sqlite3_column_count(rows);
    char *prefix = sqlite3_mprintf("INSERT INTO \"%w\" VALUES(", table);
    if (!prefix) { sqlite3_finalize(rows); return SQLITE_NOMEM; }
    GString *sql = g_string_new(prefix);
    sqlite3_free(prefix);
    for (int i = 0; i < columns; ++i) g_string_append(sql, i ? ",?" : "?");
    g_string_append_c(sql, ')');
    rc = sqlite3_prepare_v2(destination, sql->str, -1, &insert, NULL);
    g_string_free(sql, TRUE);
    if (!rc) {
        while ((rc = sqlite3_step(rows)) == SQLITE_ROW) {
            rc = SQLITE_OK;
            for (int i = 0; !rc && i < columns; ++i) {
                switch (sqlite3_column_type(rows, i)) {
                case SQLITE_INTEGER: rc = sqlite3_bind_int64(insert, i + 1, sqlite3_column_int64(rows, i)); break;
                case SQLITE_FLOAT: rc = sqlite3_bind_double(insert, i + 1, sqlite3_column_double(rows, i)); break;
                case SQLITE_TEXT: rc = sqlite3_bind_text(insert, i + 1, (const char *)sqlite3_column_text(rows, i),
                                                        sqlite3_column_bytes(rows, i), SQLITE_STATIC); break;
                case SQLITE_BLOB: rc = sqlite3_bind_blob(insert, i + 1, sqlite3_column_blob(rows, i),
                                                        sqlite3_column_bytes(rows, i), SQLITE_STATIC); break;
                default: rc = sqlite3_bind_null(insert, i + 1); break;
                }
            }
            if (!rc) rc = sqlite3_step(insert);
            if (rc != SQLITE_DONE) break;
            rc = sqlite3_reset(insert);
            sqlite3_clear_bindings(insert);
            if (rc) break;
        }
        if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    sqlite3_finalize(insert);
    sqlite3_finalize(rows);
    return rc;
}

/* The core has already installed TestOpenTab and its verification index in the
 * new encrypted file. Preserve those objects while cloning the actual remaining
 * schema and non-history rows, including DBVersionTab. Clearing history must
 * not erase metadata or invent a second version marker. */
static int h_archive_template(sqlite3 *destination, sqlite3 *source)
{
    if (!destination || !source) return SQLITE_CANTOPEN;
    int rc = h_exec(destination, "BEGIN IMMEDIATE");
    if (rc) return rc;
    sqlite3_stmt *schema = NULL;
    rc = sqlite3_prepare_v2(source,
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL"
        " AND name NOT LIKE 'sqlite_%' AND name COLLATE NOCASE!='TestOpenTab'"
        " ORDER BY rowid", -1, &schema, NULL);
    if (!rc) {
        while ((rc = sqlite3_step(schema)) == SQLITE_ROW) {
            const char *name = (const char *)sqlite3_column_text(schema, 0);
            const char *sql = (const char *)sqlite3_column_text(schema, 1);
            rc = h_exec(destination, sql);
            if (!rc && g_ascii_strcasecmp(name, "RecordTab") && g_ascii_strcasecmp(name, "CALLRecordTab"))
                rc = h_archive_copy_table(destination, source, name);
            if (rc) break;
        }
        if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    sqlite3_finalize(schema);
    schema = NULL;
    if (!rc) rc = sqlite3_prepare_v2(source,
        "SELECT sql FROM sqlite_master WHERE type IN('index','trigger','view') AND sql IS NOT NULL"
        " AND name NOT LIKE 'sqlite_%' AND tbl_name COLLATE NOCASE!='TestOpenTab'"
        " ORDER BY rowid", -1, &schema, NULL);
    if (!rc) {
        while ((rc = sqlite3_step(schema)) == SQLITE_ROW) {
            rc = h_exec(destination, (const char *)sqlite3_column_text(schema, 0));
            if (rc) break;
        }
        if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    sqlite3_finalize(schema);
    if (rc) h_exec(destination, "ROLLBACK");
    else rc = h_exec(destination, "COMMIT");
    return rc;
}

static int h_valid_message_id(const char *message)
{
    size_t length = strlen(message);
    if (length < 17 || length > 18) return 0;
    char *end = NULL;
    errno = 0;
    int64_t value = g_ascii_strtoll(message, &end, 10);
    return !errno && !*end && value >= INT64_C(50000000000000001) &&
           value <= INT64_C(199999999999999999);
}

static char *h_archive_time(const char *stamp)
{
    if (strlen(stamp) < 10) return NULL;
    char seconds[11];
    memcpy(seconds, stamp, 10);
    seconds[10] = 0;
    char *end = NULL;
    errno = 0;
    gint64 value = g_ascii_strtoll(seconds, &end, 10);
    if (errno || *end) return NULL;
    GDateTime *time = g_date_time_new_from_unix_utc(value);
    if (!time) return NULL;
    char *text = g_date_time_format(time, "%Y-%m-%d-%H.%M.%S");
    g_date_time_unref(time);
    return text;
}

static int h_archive_recover(struct im_db_context *ctx, const char *stamp)
{
    if (!stamp || !*stamp) return SQLITE_CORRUPT;
    GPtrArray *databases = NULL;
    int rc = h_databases(ctx, &databases);
    int committed = 0;
    for (guint i = 0; !rc && i < databases->len; ++i) {
        struct history_database *entry = g_ptr_array_index(databases, i);
        if (!entry->borrowed && !g_strcmp0(entry->info[2], stamp)) {
            rc = h_open(ctx, entry);
            committed = !rc;
            break;
        }
    }
    char *temporary_path = g_build_filename(im_db_directory(ctx), "tempHistory.db", NULL);
    if (!rc && committed) {
        /* Native Windows recovery can have completed the rename without leaving
         * a tempHistory.db. In that case keep the already reopened live DB. */
        if (g_file_test(temporary_path, G_FILE_TEST_EXISTS)) {
            sqlite3 *temporary = NULL;
            rc = im_db_open_file(ctx, "tempHistory.db", 0, &temporary);
            if (!rc) rc = h_backup(im_db_database(ctx, "historydb"), temporary);
            sqlite3_close(temporary);
        }
        if (!rc) rc = h_archive_state(ctx, stamp, 0, 1);
    } else if (!rc) {
        /* No metadata commit means no live reset occurred. Preserve live data. */
        rc = h_archive_state(ctx, stamp, 0, 0);
    }
    if (!rc && unlink(temporary_path) && errno != ENOENT) rc = SQLITE_IOERR_DELETE;
    g_free(temporary_path);
    g_ptr_array_free(databases, TRUE);
    return rc;
}

static int h_history_ready(struct im_db_context *ctx)
{
    const char *directory = im_db_directory(ctx);
    if (!directory || !*directory) return SQLITE_CANTOPEN;
    struct history_archive_options options;
    /* Transition state belongs to UserConfig.ini, not configuration overrides. */
    int rc = h_archive_options(ctx, &options, 0);
    if (!rc && options.started) {
        rc = h_archive_recover(ctx, options.timestamp);
    } else if (!rc) {
        char *temporary_path = g_build_filename(directory, "tempHistory.db", NULL);
        struct stat st;
        if (!stat(temporary_path, &st)) {
            /* A failed final write may have published ArchiveStart=0 without
             * synchronizing it. Reconfirm that marker durably before discarding
             * the template or accepting writes. Never restore a completed
             * transition's stale empty template over live history. */
            char *state_path = g_build_filename(directory, "UserConfig.ini", NULL);
            char *contents = NULL;
            gsize length = 0;
            GError *error = NULL;
            if (g_file_get_contents(state_path, &contents, &length, &error)) {
                rc = h_file_write(state_path, contents, length);
            } else if (!g_error_matches(error, G_FILE_ERROR, G_FILE_ERROR_NOENT)) {
                rc = SQLITE_IOERR_READ;
            }
            g_clear_error(&error);
            g_free(contents);
            g_free(state_path);
            if (!rc && unlink(temporary_path) && errno != ENOENT) rc = SQLITE_IOERR_DELETE;
        } else if (errno != ENOENT) {
            rc = SQLITE_IOERR_FSTAT;
        }
        g_free(temporary_path);
    }
    g_free(options.timestamp);
    return rc;
}

/* The core calls configure once after opening/migrating the active profile, and
 * archive on its serialized timer. It owns timer teardown and all borrowed DBs. */
int im_db_history_archive_configure(struct im_db_context *ctx, unsigned *interval_ms)
{
    struct history_archive_options options;
    int rc = h_archive_options(ctx, &options, 1);
    if (!rc && options.started) rc = h_archive_recover(ctx, options.timestamp);
    if (!rc) rc = h_reload(ctx);
    if (!rc) rc = im_db_archive_switch(ctx, options.enabled);
    if (!rc) *interval_ms = options.interval;
    g_free(options.timestamp);
    return rc;
}

int im_db_history_archive(struct im_db_context *ctx)
{
    if (!im_db_archive_enabled(ctx)) return SQLITE_OK;
    struct history_archive_options options;
    int rc = h_archive_options(ctx, &options, 1);
    if (rc) { g_free(options.timestamp); return rc; }
    if (options.started) {
        rc = h_archive_recover(ctx, options.timestamp);
        g_free(options.timestamp);
        return rc;
    }
    g_free(options.timestamp);
    char *history_path = g_build_filename(im_db_directory(ctx), "history.db", NULL);
    struct stat st;
    if (stat(history_path, &st)) { g_free(history_path); return SQLITE_IOERR_FSTAT; }
    if ((uint64_t)st.st_size < options.bytes) { g_free(history_path); return SQLITE_OK; }
    sqlite3 *history = im_db_database(ctx, "historydb");
    sqlite3_stmt *query = NULL;
    rc = history ? sqlite3_prepare_v2(history,
        "SELECT MAX(UTCSTAMP),MIN(UTCSTAMP) FROM RecordTab", -1, &query, NULL) : SQLITE_CANTOPEN;
    char *max_stamp = NULL, *min_stamp = NULL, *max_message = NULL, *min_message = NULL;
    if (!rc) {
        int step = sqlite3_step(query);
        if (step == SQLITE_ROW) {
            max_stamp = g_strdup((const char *)sqlite3_column_text(query, 0));
            min_stamp = g_strdup((const char *)sqlite3_column_text(query, 1));
        } else rc = step;
    }
    sqlite3_finalize(query);
    query = NULL;
    if (!rc && (!max_stamp || !min_stamp || !*max_stamp || !*min_stamp || !strcmp(max_stamp, "0")))
        rc = SQLITE_NOTFOUND;
    if (!rc) rc = sqlite3_prepare_v2(history,
        "SELECT MAX(UTCSTAMP),SERVERMESSAGEID,CLIENTMESSAGEID FROM RecordTab"
        " WHERE RECORDTYPE IN(0,1) AND PEERNAME!='[Group Notify]'", -1, &query, NULL);
    if (!rc) {
        int step = sqlite3_step(query);
        if (step == SQLITE_ROW) {
            const char *stamp = (const char *)sqlite3_column_text(query, 0);
            const char *server = (const char *)sqlite3_column_text(query, 1);
            const char *client = (const char *)sqlite3_column_text(query, 2);
            if (!server || !h_valid_message_id(server) || !stamp ||
                strcmp(stamp, max_stamp) || (client && !strcmp(server, client))) rc = SQLITE_NOTFOUND;
            else max_message = g_strdup(server);
        } else rc = step;
    }
    sqlite3_finalize(query);
    query = NULL;
    if (!rc) rc = sqlite3_prepare_v2(history,
        "SELECT MIN(UTCSTAMP),SERVERMESSAGEID,CLIENTMESSAGEID FROM RecordTab"
        " WHERE RECORDTYPE IN(0,1) AND PEERNAME!='[Group Notify]'", -1, &query, NULL);
    if (!rc) {
        int step = sqlite3_step(query);
        if (step == SQLITE_ROW) {
            const char *server = (const char *)sqlite3_column_text(query, 1);
            const char *client = (const char *)sqlite3_column_text(query, 2);
            min_message = g_strdup(server && h_valid_message_id(server) &&
                                   (!client || strcmp(server, client)) ? server : "0");
        } else rc = step;
    }
    sqlite3_finalize(query);
    char *formatted = max_stamp ? h_archive_time(max_stamp) : NULL;
    if (!rc && !formatted) rc = SQLITE_CORRUPT;
    GPtrArray *databases = NULL;
    if (!rc) rc = h_databases(ctx, &databases);
    unsigned number = 0;
    if (!rc) {
        struct history_database *live = h_route(databases, "", "");
        if (!live) rc = SQLITE_CORRUPT;
        else number = live->number;
    }
    char *archive_dir = g_build_filename(im_db_directory(ctx), "ArchiveFiles", NULL);
    char *database_name = formatted ? g_strconcat(formatted, "_Archive.db", NULL) : NULL;
    char *key_name = formatted ? g_strconcat(formatted, "_config_private.db", NULL) : NULL;
    char *archive_path = database_name ? g_build_filename(archive_dir, database_name, NULL) : NULL;
    char *key_path = key_name ? g_build_filename(archive_dir, key_name, NULL) : NULL;
    char *live_key_path = g_build_filename(im_db_directory(ctx), "config_private.db", NULL);
    char *metadata_path = g_build_filename(archive_dir, "DatabaseInfo.dat", NULL);
    char *temporary_path = g_build_filename(im_db_directory(ctx), "tempHistory.db", NULL);
    char *old_metadata = NULL;
    gsize old_length = 0;
    GError *error = NULL;
    if (!rc && !g_file_get_contents(metadata_path, &old_metadata, &old_length, &error) &&
        !g_error_matches(error, G_FILE_ERROR, G_FILE_ERROR_NOENT)) rc = SQLITE_IOERR_READ;
    g_clear_error(&error);
    sqlite3 *temporary = NULL, *archive = NULL;
    int created_db = 0, created_key = 0, created_temp = 0, metadata_written = 0, reset_live = 0;
    if (!rc && !im_db_archive_enabled(ctx)) rc = SQLITE_ABORT;
    if (!rc && g_mkdir_with_parents(archive_dir, 0700)) rc = SQLITE_IOERR;
    if (!rc && g_file_test(temporary_path, G_FILE_TEST_EXISTS)) rc = SQLITE_BUSY;
    if (!rc && g_file_test(archive_path, G_FILE_TEST_EXISTS)) rc = SQLITE_BUSY;
    if (!rc) {
        rc = im_db_open_file(ctx, "tempHistory.db", 1, &temporary);
        created_temp = !rc;
    }
    if (!rc) rc = h_archive_template(temporary, history);
    if (!rc) { rc = h_file_copy(live_key_path, key_path); created_key = !rc; }
    if (!rc) {
        char *relative_db = g_build_filename("ArchiveFiles", database_name, NULL);
        char *relative_key = g_build_filename("ArchiveFiles", key_name, NULL);
        rc = im_db_open_archive(ctx, relative_db, relative_key, 1, &archive);
        created_db = !rc;
        g_free(relative_key);
        g_free(relative_db);
    }
    if (!rc) rc = h_backup(archive, history);
    if (!rc) rc = sqlite3_wal_checkpoint_v2(archive, NULL, SQLITE_CHECKPOINT_TRUNCATE, NULL, NULL);
    if (archive) {
        int close_rc = sqlite3_close(archive);
        if (!rc) rc = close_rc;
        archive = NULL;
    }
    if (!rc) rc = h_archive_state(ctx, max_stamp, 1, 2);
    if (!rc) {
        GString *metadata = g_string_new_len(old_metadata, (gssize)old_length);
        if (metadata->len && metadata->str[metadata->len - 1] != '\n') g_string_append_c(metadata, '\n');
        g_string_append_printf(metadata, "%s#%s#%s#%s#%s#%s#%u\n", database_name, key_name,
                               max_stamp, min_stamp, max_message, min_message, number);
        rc = h_file_write(metadata_path, metadata->str, metadata->len);
        metadata_written = !rc;
        g_string_free(metadata, TRUE);
    }
    if (!rc) { rc = h_backup(history, temporary); reset_live = !rc; }
    if (!rc) rc = h_archive_state(ctx, max_stamp, 0, 1);
    sqlite3_close(temporary);
    if (rc && metadata_written && !reset_live) {
        int restore = h_file_write(metadata_path, old_metadata ? old_metadata : "", old_length);
        if (!restore) metadata_written = 0;
    }
    if (!reset_live && !metadata_written) {
        if (created_db) unlink(archive_path);
        if (created_key) unlink(key_path);
        if (created_temp) unlink(temporary_path);
        if (created_db) h_archive_state(ctx, max_stamp, 0, 0);
    } else if (!rc && created_temp && unlink(temporary_path)) rc = SQLITE_IOERR_DELETE;
    if (databases) g_ptr_array_free(databases, TRUE);
    g_free(temporary_path);
    g_free(old_metadata);
    g_free(metadata_path);
    g_free(live_key_path);
    g_free(key_path);
    g_free(archive_path);
    g_free(key_name);
    g_free(database_name);
    g_free(archive_dir);
    g_free(formatted);
    g_free(min_message);
    g_free(max_message);
    g_free(min_stamp);
    g_free(max_stamp);
    g_free(history_path);
    return rc;
}
