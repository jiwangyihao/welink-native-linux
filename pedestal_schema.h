/* Original pedestal table/JSON mapping; column order is part of the SDK contract. */
#ifndef WELINK_PEDESTAL_SCHEMA_H
#define WELINK_PEDESTAL_SCHEMA_H
enum pedestal_kind { P_TEXT, P_INTEGER, P_JSON };
struct pedestal_field { const char *name; enum pedestal_kind kind; };
struct pedestal_record { const char *insert_sql; const struct pedestal_field *fields; size_t count; };
#define LOGIN_SCHEMA "CREATE TABLE IF NOT EXISTS LoginListTab( AUTOID INTEGER PRIMARY KEY  AUTOINCREMENT, ACCOUNT VARCHAR(32) NOT NULL, DISPLAYACCOUNT VARCHAR(32) NOT NULL, PASSWORD VARCHAR(128) NOT NULL, AUTOLOGIN BOOLEAN NOT NULL DEFAULT(0), REMPWD BOOLEAN NOT NULL DEFAULT(0), USERRANDOM VARCHAR(128), TIMESTAMP VARCHAR(32), TENANTCN VARCHAR(151) NOT NULL, TENANTEN VARCHAR(128) NOT NULL, TENANTID VARCHAR(128) NOT NULL, THIRDCERTYPE BOOLEAN NOT NULL DEFAULT(0), ISMAXHUBWORKPLACE INTEGER, THIRDACCOUNT VARCHAR(129), MAXHUBMIDDLEENDADDRESS VARCHAR(256), SETPASSWORDTOKEN VARCHAR(512), THIRDAUTHTYPE VARCHAR(4), THIRDLOGINURL VARCHAR(512), REALNAMEAUTH  INTEGER, USERIV VARCHAR(289), SITETYPE  INTEGER, REFRESHTOKEN VARCHAR(512), INTERNATIONALSITEFLAG INTEGER NOT NULL DEFAULT(0), REGIONALSITE VARCHAR(256), EXPARAMS VARCHAR(1024));"
#define LOGIN_SELECT "SELECT AUTOID,ACCOUNT,DISPLAYACCOUNT,PASSWORD,AUTOLOGIN,REMPWD,USERRANDOM,TIMESTAMP,TENANTCN,TENANTEN,TENANTID,THIRDCERTYPE,ISMAXHUBWORKPLACE,THIRDACCOUNT,MAXHUBMIDDLEENDADDRESS,SETPASSWORDTOKEN,THIRDAUTHTYPE,THIRDLOGINURL,REALNAMEAUTH,USERIV,SITETYPE,REFRESHTOKEN,INTERNATIONALSITEFLAG,REGIONALSITE,EXPARAMS FROM LoginListTab"
static const struct pedestal_field login_fields[] = {
    {"id",1},
    {"account",0},
    {"displayaccount",0},
    {"userpwd",0},
    {"isautologin",1},
    {"isrememberpwd",1},
    {"userrandom",0},
    {"timestamp",0},
    {"tenantcn",0},
    {"tenanten",0},
    {"tenantid",0},
    {"thirdcertype",1},
    {"isMaxhubWorkplace",1},
    {"thirdaccount",0},
    {"maxhubMiddleEndAddress",0},
    {"setPasswordToken",0},
    {"thirdAuthType",0},
    {"thirdLoginUrl",0},
    {"realNameAuth",1},
    {"useriv",0},
    {"sitetype",1},
    {"refreshToken",0},
    {"internationalSiteFlag",1},
    {"regionalSite",0},
    {"exparams",P_JSON},
};
static const struct pedestal_record login_record = {
    "INSERT OR REPLACE INTO LoginListTab(AUTOID,ACCOUNT,DISPLAYACCOUNT,PASSWORD,AUTOLOGIN,REMPWD,USERRANDOM,TIMESTAMP,TENANTCN,TENANTEN,TENANTID,THIRDCERTYPE,ISMAXHUBWORKPLACE,THIRDACCOUNT,MAXHUBMIDDLEENDADDRESS,SETPASSWORDTOKEN,THIRDAUTHTYPE,THIRDLOGINURL,REALNAMEAUTH,USERIV,SITETYPE,REFRESHTOKEN,INTERNATIONALSITEFLAG,REGIONALSITE,EXPARAMS) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    login_fields, sizeof(login_fields)/sizeof(login_fields[0])
};
#define CALL_SCHEMA "CREATE TABLE IF NOT EXISTS CALLRecordTab( AUTOID  INTEGER PRIMARY KEY AUTOINCREMENT, PEERACCOUNT VARCHAR(64), ISCALLOUT INTEGER, CALLERNUMBER VARCHAR(32) , CALLEENUMBER VARCHAR(32) , CALLSTATE INTEGER , CALLTYPE INTEGER , CONFID VARCHAR(32) , CONFPASSCODE VARCHAR(64) , CONFMEMBERS VARCHAR(1024) , GROUPID VARCHAR(64) , STARTTIME INTEGER , EXPARAMS VARCHAR(256) , DURATION INTEGER);"
#define CALL_SELECT "SELECT AUTOID,PEERACCOUNT,ISCALLOUT,CALLERNUMBER,CALLEENUMBER,CALLSTATE,CALLTYPE,CONFID,CONFPASSCODE,CONFMEMBERS,GROUPID,STARTTIME,EXPARAMS,DURATION FROM CALLRecordTab"
static const struct pedestal_field call_fields[] = {
    {"id",1},
    {"peeraccount",0},
    {"iscallout",1},
    {"callernumber",0},
    {"calleenumber",0},
    {"callstate",1},
    {"calltype",1},
    {"confid",0},
    {"confpasscode",0},
    {"confmembers",0},
    {"groupid",0},
    {"starttime",1},
    {"exparams",0},
    {"duration",1},
};
static const struct pedestal_record call_record = {
    "INSERT OR REPLACE INTO CALLRecordTab(AUTOID,PEERACCOUNT,ISCALLOUT,CALLERNUMBER,CALLEENUMBER,CALLSTATE,CALLTYPE,CONFID,CONFPASSCODE,CONFMEMBERS,GROUPID,STARTTIME,EXPARAMS,DURATION) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    call_fields, sizeof(call_fields)/sizeof(call_fields[0])
};
#define SYSTEM_CONFIG_SCHEMA "CREATE TABLE IF NOT EXISTS SysConfigTab( AUTOID  INTEGER PRIMARY KEY AUTOINCREMENT, KEY    VARCHAR(256) NOT NULL, VALUE  VARCHAR(512));"
#define SYSTEM_CONFIG_SELECT "SELECT AUTOID,KEY,VALUE FROM SysConfigTab"
static const struct pedestal_field system_config_fields[] = {
    {"id",1},
    {"strkey",0},
    {"strvalue",0},
};
static const struct pedestal_record system_config_record = {
    "INSERT OR REPLACE INTO SysConfigTab(AUTOID,KEY,VALUE) VALUES(?,?,?)",
    system_config_fields, sizeof(system_config_fields)/sizeof(system_config_fields[0])
};
#define USER_CONFIG_SCHEMA "CREATE TABLE IF NOT EXISTS UserConfigTab( AUTOID  INTEGER PRIMARY KEY AUTOINCREMENT, KEY    VARCHAR(256) NOT NULL, VALUE  VARCHAR(512));"
#define USER_CONFIG_SELECT "SELECT AUTOID,KEY,VALUE FROM UserConfigTab"
static const struct pedestal_field user_config_fields[] = {
    {"id",1},
    {"strkey",0},
    {"strvalue",0},
};
static const struct pedestal_record user_config_record = {
    "INSERT OR REPLACE INTO UserConfigTab(AUTOID,KEY,VALUE) VALUES(?,?,?)",
    user_config_fields, sizeof(user_config_fields)/sizeof(user_config_fields[0])
};
#define DB_VERSION_SCHEMA "CREATE TABLE IF NOT EXISTS DBVersionTab( VERSION_KEY    VARCHAR(20) NOT NULL PRIMARY KEY, VERSION_VALUE  VARCHAR(20));"
#endif
