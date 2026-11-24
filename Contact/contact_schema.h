/* Original contact.dll DDL (VAs below), and plugin.c RPC field names. */
#ifndef WELINK_CONTACT_SCHEMA_H
#define WELINK_CONTACT_SCHEMA_H
enum contact_kind { C_TEXT, C_INTEGER, C_DEFAULT_ONE };
struct contact_field { const char *json, *column; enum contact_kind kind; };
struct contact_record { const char *table, *list, *insert_sql, *select_sql; const struct contact_field *fields; size_t count; };
static const struct contact_field system_fields[] = {
    {"id", "AUTOID", C_INTEGER},
    {"strkey", "KEY", C_TEXT},
    {"strvalue", "VALUE", C_TEXT},
};
static const struct contact_record system_record = {
    "SysConfigTab", "_sysconfiglist", "INSERT OR REPLACE INTO SysConfigTab(AUTOID,KEY,VALUE) VALUES(?,?,?)", "SELECT AUTOID,KEY,VALUE FROM SysConfigTab",
    system_fields, sizeof(system_fields) / sizeof(system_fields[0])
};
static const struct contact_field contact_fields[] = {
    {"id", "AUTOID", C_INTEGER},
    {"contact_id", "CONTACTID", C_TEXT},
    {"account", "ACCOUNT", C_TEXT},
    {"staff_id", "STAFFID", C_INTEGER},
    {"name", "NAME", C_TEXT},
    {"q_pin_yin", "QPINYIN", C_TEXT},
    {"gender", "GENDER", C_INTEGER},
    {"mobile", "MOBILEPHONE", C_TEXT},
    {"office_phone", "OFFICEPHONE", C_TEXT},
    {"other_phone", "OTHERPHONE", C_TEXT},
    {"fax", "FAX", C_TEXT},
    {"email", "EMAIL", C_TEXT},
    {"postcode", "ZIP", C_TEXT},
    {"address", "ADDRESS", C_TEXT},
    {"title", "TITLE", C_TEXT},
    {"dept_name", "DEPTNAME", C_TEXT},
    {"image_id", "IMAGEID", C_TEXT},
    {"signature", "SIGNATURE", C_TEXT},
    {"website", "WEBSITE", C_TEXT},
    {"bind_no", "BINDNO", C_TEXT},
    {"englishName", "ENGLISHNAME", C_TEXT},
    {"staff_no", "STAFFNO", C_TEXT},
    {"crop_name", "CORPNAME", C_TEXT},
    {"dept_id", "DEPTID", C_TEXT},
    {"dept_name_cn", "DEPTNAMECN", C_TEXT},
    {"dept_name_en", "DEPTNAMEEN", C_TEXT},
    {"desc", "DESC", C_TEXT},
    {"foreign_name", "FOREIGNNAME", C_TEXT},
    {"im_no", "IMNO", C_TEXT},
    {"image_sync_time", "IMAGESYNCTIME", C_TEXT},
    {"ip_phone", "IPPHONE", C_TEXT},
    {"is_security", "ISSECURITY", C_INTEGER},
    {"nick_name", "NICKNAME", C_TEXT},
    {"old_account", "OLDACCOUNT", C_TEXT},
    {"short_phone", "SHORTPHONE", C_TEXT},
    {"voip", "VOIP", C_TEXT},
    {"modify_time", "MODIFYTIME", C_TEXT},
    {"home_phone", "HOMEPHONE", C_TEXT},
    {"other_phone2", "OTHERPHONE2", C_TEXT},
    {"office_phone2", "OFFICEPHONE2", C_TEXT},
    {"espacenumber", "ESPACENUMBER", C_TEXT},
    {"etag", "ETAG", C_TEXT},
    {"exparams", "EXPARAM", C_TEXT},
    {"show_account", "SHOWACCOUNT", C_TEXT},
    {"time_stamp", "TIMESTAMP", C_TEXT},
    {"isExternalContact", "ISEXTERNALCONTACT", C_INTEGER},
    {"vmrId", "VMRID", C_TEXT},
    {"externalType", "EXTERNALTYPE", C_INTEGER},
    {"isHardTerminal", "ISHARDTERMINAL", C_INTEGER},
    {"mobileCountry", "MOBILECOUNTRY", C_INTEGER},
    {"officePhoneCountry", "OFFICEPHONECOUNTRY", C_INTEGER},
    {"statusCode", "ISRESTRICTEDUSER", C_INTEGER},
    {"deptL1Name", "DEPTLL1NAME", C_TEXT},
    {"display_dept", "DISPLAYDEPT", C_TEXT},
    {"deptInfo", "DEPTINFOLIST", C_TEXT},
    {"isExternal", "EMPLOYEETYPE", C_TEXT},
    {"workId", "WORKID", C_TEXT},
    {"personAssistantAll", "PERSONASSISTANTALL", C_TEXT},
    {"extInfo", "EXTINFO", C_TEXT},
    {"personMobileList", "PERSONMOBILELIST", C_TEXT},
    {"crop_name_cn", "CROPNAMECN", C_TEXT},
    {"crop_name_en", "CROPNAMEEN", C_TEXT},
    {"seniorMode", "SENIORMODE", C_INTEGER},
    {"isHidden", "ISHIDDEN", C_INTEGER},
    {"userStatus", "USERSTATUS", C_INTEGER},
    {"tenantId", "TENANTID", C_TEXT},
    {"tidType", "TIDTYPE", C_INTEGER},
    {"updateTimestamp", "UPDATETIMESTAMP", C_INTEGER},
    {"userType", "USERTYPE", C_DEFAULT_ONE},
    {"verifiedStatus", "VERIFIEDSTATUS", C_DEFAULT_ONE},
};
static const struct contact_record contact_record = {
    "ContactTab", "_contactinfolist", "INSERT OR REPLACE INTO ContactTab(AUTOID,CONTACTID,ACCOUNT,STAFFID,NAME,QPINYIN,GENDER,MOBILEPHONE,OFFICEPHONE,OTHERPHONE,FAX,EMAIL,ZIP,ADDRESS,TITLE,DEPTNAME,IMAGEID,SIGNATURE,WEBSITE,BINDNO,ENGLISHNAME,STAFFNO,CORPNAME,DEPTID,DEPTNAMECN,DEPTNAMEEN,DESC,FOREIGNNAME,IMNO,IMAGESYNCTIME,IPPHONE,ISSECURITY,NICKNAME,OLDACCOUNT,SHORTPHONE,VOIP,MODIFYTIME,HOMEPHONE,OTHERPHONE2,OFFICEPHONE2,ESPACENUMBER,ETAG,EXPARAM,SHOWACCOUNT,TIMESTAMP,ISEXTERNALCONTACT,VMRID,EXTERNALTYPE,ISHARDTERMINAL,MOBILECOUNTRY,OFFICEPHONECOUNTRY,ISRESTRICTEDUSER,DEPTLL1NAME,DISPLAYDEPT,DEPTINFOLIST,EMPLOYEETYPE,WORKID,PERSONASSISTANTALL,EXTINFO,PERSONMOBILELIST,CROPNAMECN,CROPNAMEEN,SENIORMODE,ISHIDDEN,USERSTATUS,TENANTID,TIDTYPE,UPDATETIMESTAMP,USERTYPE,VERIFIEDSTATUS,INVERTNAME,NAMELENGTH) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", "SELECT AUTOID,CONTACTID,ACCOUNT,STAFFID,NAME,QPINYIN,GENDER,MOBILEPHONE,OFFICEPHONE,OTHERPHONE,FAX,EMAIL,ZIP,ADDRESS,TITLE,DEPTNAME,IMAGEID,SIGNATURE,WEBSITE,BINDNO,ENGLISHNAME,STAFFNO,CORPNAME,DEPTID,DEPTNAMECN,DEPTNAMEEN,DESC,FOREIGNNAME,IMNO,IMAGESYNCTIME,IPPHONE,ISSECURITY,NICKNAME,OLDACCOUNT,SHORTPHONE,VOIP,MODIFYTIME,HOMEPHONE,OTHERPHONE2,OFFICEPHONE2,ESPACENUMBER,ETAG,EXPARAM,SHOWACCOUNT,TIMESTAMP,ISEXTERNALCONTACT,VMRID,EXTERNALTYPE,ISHARDTERMINAL,MOBILECOUNTRY,OFFICEPHONECOUNTRY,ISRESTRICTEDUSER,DEPTLL1NAME,DISPLAYDEPT,DEPTINFOLIST,EMPLOYEETYPE,WORKID,PERSONASSISTANTALL,EXTINFO,PERSONMOBILELIST,CROPNAMECN,CROPNAMEEN,SENIORMODE,ISHIDDEN,USERSTATUS,TENANTID,TIDTYPE,UPDATETIMESTAMP,USERTYPE,VERIFIEDSTATUS FROM ContactTab",
    contact_fields, sizeof(contact_fields) / sizeof(contact_fields[0])
};
static const struct contact_field config_fields[] = {
    {"id", "AUTOID", C_INTEGER},
    {"strkey", "KEY", C_TEXT},
    {"strvalue", "VALUE", C_TEXT},
};
static const struct contact_record config_record = {
    "UserConfigTab", "_userconfiglist", "INSERT OR REPLACE INTO UserConfigTab(AUTOID,KEY,VALUE) VALUES(?,?,?)", "SELECT AUTOID,KEY,VALUE FROM UserConfigTab",
    config_fields, sizeof(config_fields) / sizeof(config_fields[0])
};
static const struct contact_field friend_fields[] = {
    {"id", "AUTOID", C_INTEGER},
    {"friendAccount", "FRIENDACCOUNT", C_TEXT},
    {"corpId", "CORPID", C_TEXT},
    {"friendGroupId", "FRIENDGROUPID", C_TEXT},
    {"friendNickname", "FRIENDNICKNAME", C_TEXT},
    {"friendOwnerAccount", "FRIENDOWNERACCOUNT", C_TEXT},
    {"groupMemberId", "GROUPMEMBERID", C_TEXT},
    {"isNotify", "ISNOTIFY", C_INTEGER},
    {"state", "STATE", C_TEXT},
    {"createTime", "CREATETIME", C_TEXT},
    {"modifyTime", "MODIFYTIME", C_TEXT},
};
static const struct contact_record friend_record = {
    "FriendshipTab", "_friendshipinfolist", "INSERT OR REPLACE INTO FriendshipTab(AUTOID,FRIENDACCOUNT,CORPID,FRIENDGROUPID,FRIENDNICKNAME,FRIENDOWNERACCOUNT,GROUPMEMBERID,ISNOTIFY,STATE,CREATETIME,MODIFYTIME) VALUES(?,?,?,?,?,?,?,?,?,?,?)", "SELECT AUTOID,FRIENDACCOUNT,CORPID,FRIENDGROUPID,FRIENDNICKNAME,FRIENDOWNERACCOUNT,GROUPMEMBERID,ISNOTIFY,STATE,CREATETIME,MODIFYTIME FROM FriendshipTab",
    friend_fields, sizeof(friend_fields) / sizeof(friend_fields[0])
};
static const struct contact_field member_fields[] = {
    {"id", "AUTOID", C_INTEGER},
    {"contact_id", "CID", C_TEXT},
    {"group_id", "CTAGID", C_TEXT},
    {"state", "STATE", C_INTEGER},
};
static const struct contact_record member_record = {
    "ContactCustomTagTab", "_groupmeminfolist", "INSERT OR REPLACE INTO ContactCustomTagTab(AUTOID,CID,CTAGID,STATE) VALUES(?,?,?,?)", "SELECT AUTOID,CID,CTAGID,STATE FROM ContactCustomTagTab",
    member_fields, sizeof(member_fields) / sizeof(member_fields[0])
};
static const struct contact_field remark_fields[] = {
    {"id", "AUTOID", C_INTEGER},
    {"employeeAccount", "REMARKACCOUNT", C_TEXT},
    {"remark", "REMARK", C_TEXT},
};
static const struct contact_record remark_record = {
    "RemarkTab", "_remarklist", "INSERT OR REPLACE INTO RemarkTab(AUTOID,REMARKACCOUNT,REMARK) VALUES(?,?,?)", "SELECT AUTOID,REMARKACCOUNT,REMARK FROM RemarkTab",
    remark_fields, sizeof(remark_fields) / sizeof(remark_fields[0])
};
static const struct contact_field group_fields[] = {
    {"autoId", "AUTOID", C_INTEGER},
    {"groupId", "GROUPID", C_TEXT},
    {"groupNameCn", "GROUPNAMECN", C_TEXT},
    {"groupNameEn", "GROUPNAMEEN", C_TEXT},
    {"indexNo", "INDEXNO", C_INTEGER},
};
static const struct contact_record group_record = {
    "ContactGroupTab", "_groupinfolist", "INSERT OR REPLACE INTO ContactGroupTab(AUTOID,GROUPID,GROUPNAMECN,GROUPNAMEEN,INDEXNO) VALUES(?,?,?,?,?)", "SELECT AUTOID,GROUPID,GROUPNAMECN,GROUPNAMEEN,INDEXNO FROM ContactGroupTab",
    group_fields, sizeof(group_fields) / sizeof(group_fields[0])
};
static const char *const system_schema[] = {
    /* contact.dll 0x100de1b0 */
    "CREATE TABLE IF NOT EXISTS SysConfigTab( AUTOID  INTEGER PRIMARY KEY AUTOINCREMENT, KEY    VARCHAR(256) NOT NULL, VALUE  VARCHAR(512));",
    /* contact.dll 0x100de238 */
    "CREATE UNIQUE INDEX IF NOT EXISTS SYSCONFIG_UNIQUE_INDEX ON SysConfigTab(KEY);",
};
static const char *const user_schema[] = {
    /* contact.dll 0x100ded00 */
    "CREATE TABLE IF NOT EXISTS ContactTab( AUTOID INTEGER PRIMARY KEY AUTOINCREMENT, CONTACTID VARCHAR(32), ACCOUNT VARCHAR(32), STAFFID INTEGER, NAME VARCHAR(64), INVERTNAME VARCHAR(64), NAMELENGTH INTEGER, QPINYIN VARCHAR(64), GENDER INTEGER , MOBILEPHONE VARCHAR(32) , OFFICEPHONE VARCHAR(32) , OTHERPHONE VARCHAR(32) , FAX VARCHAR(32) , EMAIL VARCHAR(64), ZIP VARCHAR(16), ADDRESS VARCHAR(256) , TITLE VARCHAR(256) , DEPTNAME VARCHAR(256) , IMAGEID VARCHAR(64) , SIGNATURE VARCHAR(256), WEBSITE VARCHAR(64), BINDNO VARCHAR(32), ENGLISHNAME VARCHAR(64), STAFFNO VARCHAR(32) , CORPNAME VARCHAR(151), DEPTID VARCHAR(32), DEPTNAMECN VARCHAR(256), DEPTNAMEEN VARCHAR(256), DESC VARCHAR(32), FOREIGNNAME VARCHAR(64), IMNO VARCHAR(32), IMAGESYNCTIME VARCHAR(64), IPPHONE VARCHAR(32), ISSECURITY INTEGER, NICKNAME VARCHAR(64), OLDACCOUNT VARCHAR(32), SHORTPHONE VARCHAR(32), VOIP VARCHAR(32), MODIFYTIME VARCHAR(32), HOMEPHONE VARCHAR(32), OTHERPHONE2 VARCHAR(32), OFFICEPHONE2 VARCHAR(32), ESPACENUMBER VARCHAR(32), ETAG VARCHAR(32), EXPARAM VARCHAR(256), SHOWACCOUNT VARCHAR(129), TIMESTAMP VARCHAR(32), ISEXTERNALCONTACT INTEGER, VMRID VARCHAR(32), EXTERNALTYPE INTEGER, ISHARDTERMINAL INTEGER, MOBILECOUNTRY INTEGER, OFFICEPHONECOUNTRY INTEGER, ISRESTRICTEDUSER INTEGER, DEPTLL1NAME VARCHAR(256), DISPLAYDEPT VARCHAR(256), DEPTINFOLIST VARCHAR(1280), EMPLOYEETYPE VARCHAR(8), WORKID VARCHAR(64), PERSONASSISTANTALL VARCHAR(64), EXTINFO VARCHAR(64), PERSONMOBILELIST VARCHAR(360), CROPNAMECN VARCHAR(256) , CROPNAMEEN VARCHAR(256) , SENIORMODE INTEGER, ISHIDDEN INTEGER, USERSTATUS INTEGER, TENANTID VARCHAR(64), TIDTYPE INTEGER, UPDATETIMESTAMP, USERTYPE INTEGER DEFAULT 1, VERIFIEDSTATUS INTEGER DEFAULT 1);",
    /* contact.dll 0x100df3b0 */
    "CREATE UNIQUE INDEX IF NOT EXISTS CONTACT_UNIQUE_INDEX ON ContactTab(ACCOUNT);",
    /* contact.dll 0x100df400 */
    "CREATE INDEX IF NOT EXISTS CONTACT_TIMESTAMP_INDEX ON ContactTab(UPDATETIMESTAMP);",
    /* contact.dll 0x100df458 */
    "CREATE INDEX IF NOT EXISTS CONTACT_NAME_INDEX ON ContactTab(NAME);",
    /* contact.dll 0x100df4a0 */
    "CREATE INDEX IF NOT EXISTS CONTACT_INVERTNAME_INDEX ON ContactTab(INVERTNAME);",
    /* contact.dll 0x100df4f0 */
    "CREATE INDEX IF NOT EXISTS CONTACT_NAMELENGTH_INDEX ON ContactTab(NAMELENGTH);",
    /* contact.dll 0x100df540 */
    "CREATE INDEX IF NOT EXISTS CONTACT_QPINYIN_INDEX ON ContactTab(QPINYIN);",
    /* contact.dll 0x100df590 */
    "CREATE INDEX IF NOT EXISTS CONTACT_ACCOUNT_INDEX ON ContactTab(ACCOUNT);",
    /* contact.dll 0x100e1458; never reproduce its destructive DROP prefix. */
    "CREATE TABLE IF NOT EXISTS ContactCustomTagTab( AUTOID INTEGER PRIMARY KEY AUTOINCREMENT, CID VARCHAR(32) NOT NULL, CTAGID VARCHAR(32) NOT NULL, STATE INTEGER);",
    /* contact.dll 0x100e1528 */
    "CREATE UNIQUE INDEX IF NOT EXISTS CONTACTCUSTOMTAG_UNIQUE_INDEX ON ContactCustomTagTab(CID,CTAGID);",
    /* contact.dll 0x100e2398 */
    "CREATE TABLE IF NOT EXISTS ContactGroupTab( AUTOID INTEGER PRIMARY KEY AUTOINCREMENT, GROUPID VARCHAR(1024), GROUPNAMECN VARCHAR(1024), GROUPNAMEEN VARCHAR(1024), INDEXNO INTEGER);",
    /* contact.dll 0x100e2450 */
    "CREATE UNIQUE INDEX IF NOT EXISTS UNI_CONTACTGROUPTAB_UNIQUE_INDEX_GROUPID ON ContactGroupTab(GROUPID);",
    /* contact.dll 0x100e24b8 */
    "CREATE INDEX IF NOT EXISTS CONTACTGROUPTAB_INDEX_INDEXNO ON ContactGroupTab(INDEXNO);",
    /* contact.dll 0x100e3030 */
    "CREATE TABLE IF NOT EXISTS FriendshipTab( AUTOID INTEGER PRIMARY KEY AUTOINCREMENT, FRIENDACCOUNT VARCHAR(32), CORPID VARCHAR(32), FRIENDGROUPID VARCHAR(32), FRIENDNICKNAME VARCHAR(32), FRIENDOWNERACCOUNT VARCHAR(32) , GROUPMEMBERID VARCHAR(32) , ISNOTIFY INTEGER , STATE VARCHAR(8) , CREATETIME VARCHAR(32), MODIFYTIME VARCHAR(32));",
    /* contact.dll 0x100e3180 */
    "CREATE UNIQUE INDEX IF NOT EXISTS FRIENDSHIP_UNIQUE_INDEX ON FriendshipTab(FRIENDACCOUNT);",
    /* contact.dll 0x100e39b8 */
    "CREATE TABLE IF NOT EXISTS RemarkTab( AUTOID INTEGER PRIMARY KEY AUTOINCREMENT, REMARKACCOUNT VARCHAR(32), REMARK VARCHAR(32) , EXDATA1 TEXT , EXDATA2 TEXT );",
    /* contact.dll 0x100e3a58 */
    "CREATE UNIQUE INDEX IF NOT EXISTS REMARK_UNIQUE_INDEX ON RemarkTab(REMARKACCOUNT);",
    /* contact.dll 0x100e3d50 */
    "CREATE TABLE IF NOT EXISTS UserConfigTab( AUTOID  INTEGER PRIMARY KEY AUTOINCREMENT, KEY    VARCHAR(256) NOT NULL, VALUE  VARCHAR(512));",
    /* contact.dll 0x100e3de0 */
    "CREATE UNIQUE INDEX IF NOT EXISTS USERCONFIG_UNIQUE_INDEX ON UserConfigTab(KEY);",
};
static const char *const gab_schema[] = {
    /* contact.dll 0x100dbae8 */
    "CREATE TABLE IF NOT EXISTS \"ct_person_info\" ( \"person_account\" TEXT, \"person_code\" TEXT, \"person_number\" TEXT, \"person_name_cn\" TEXT, \"person_name_en\" TEXT, \"person_pinyin_name\" TEXT, \"firstname\" TEXT, \"lastname\" TEXT, \"sex\" TEXT, \"birthday\" TEXT, \"web_site\" TEXT, \"person_assistant_number\" TEXT, \"posts_rank\" TEXT, \"person_competence\" TEXT, \"person_type\" TEXT, \"manager_flag\" TEXT, \"user_reg_number\" TEXT, \"person_phone_code\" TEXT, \"fax_code\" TEXT, \"imno_code\" TEXT, \"person_mobile_viop_code\" TEXT, \"person_internal_code\" TEXT, \"person_email\" TEXT, \"email_login_account\" TEXT, \"person_room\" TEXT, \"person_address\" TEXT, \"location_code\" TEXT, \"zip_code\" TEXT, \"photo_last_updated_time\" TEXT, \"source\" TEXT, \"person_diffierence_time\" TEXT, \"time_zone\" TEXT, \"person_signed\" TEXT, \"user_status\" INTEGER, \"sip_num\" TEXT, \"vmr_id\" TEXT, \"card_id\" TEXT, \"operation_status\" INTEGER, \"is_hidden\" INTEGER, \"remark\" TEXT, \"senior_mode\" INTEGER, \"moblie0\" TEXT, \"moblie1\" TEXT, \"moblie2\" TEXT, \"moblie3\" TEXT, \"moblie4\" TEXT, \"roles\" TEXT, \"last_updated_time\" TEXT, \"avatar_default_en\" TEXT, \"avatar_default_cn\" TEXT, \"avatar_default_en_large\" TEXT, \"avatar_default_cn_large\" TEXT, \"avatar_custom\" TEXT, \"avatar_custom_large\" TEXT, \"last_sync_time\"  INTEGER, \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT, \"ext4\" TEXT, \"ext5\" TEXT, PRIMARY KEY(\"person_account\"))",
    /* contact.dll 0x100dc030 */
    "CREATE TABLE IF NOT EXISTS \"ct_account_info\" ( \"person_account\" TEXT, \"person_code\" TEXT, \"person_number\" TEXT, \"person_name_cn\" TEXT, \"person_name_en\" TEXT, \"person_pinyin_name\" TEXT, \"firstname\" TEXT, \"lastname\" TEXT, \"sex\" TEXT, \"birthday\" TEXT, \"web_site\" TEXT, \"person_assistant_number\" TEXT, \"posts_rank\" TEXT, \"person_competence\" TEXT, \"person_type\" TEXT, \"manager_flag\" TEXT, \"user_reg_number\" TEXT, \"person_phone_code\" TEXT, \"fax_code\" TEXT, \"imno_code\" TEXT, \"person_mobile_viop_code\" TEXT, \"person_internal_code\" TEXT, \"person_email\" TEXT, \"email_login_account\" TEXT, \"person_room\" TEXT, \"person_address\" TEXT, \"location_code\" TEXT, \"zip_code\" TEXT, \"photo_last_updated_time\" TEXT, \"source\" TEXT, \"person_diffierence_time\" TEXT, \"time_zone\" TEXT, \"person_signed\" TEXT, \"user_status\" INTEGER, \"sip_num\" TEXT, \"vmr_id\" TEXT, \"card_id\" TEXT, \"operation_status\" INTEGER, \"is_hidden\" INTEGER, \"remark\" TEXT, \"senior_mode\" INTEGER, \"moblie0\" TEXT, \"moblie1\" TEXT, \"moblie2\" TEXT, \"moblie3\" TEXT, \"moblie4\" TEXT, \"roles\" TEXT, \"avatar_default_en\" TEXT, \"avatar_default_cn\" TEXT, \"avatar_default_en_large\" TEXT, \"avatar_default_cn_large\" TEXT, \"avatar_custom\" TEXT, \"avatar_custom_large\" TEXT, \"last_updated_time\" TEXT, \"last_sync_time\"  INTEGER, \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT, \"ext4\" TEXT, \"ext5\" TEXT, PRIMARY KEY(\"person_account\"))",
    /* contact.dll 0x100dc578 */
    "CREATE TABLE IF NOT EXISTS \"ct_person_ext\" (  \"person_account\"  TEXT,  \"key_id\"  TEXT,  \"field_value\"  TEXT,  \"field_value_en\"  TEXT,  \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT,UNIQUE(\"person_account\", \"key_id\"))",
    /* contact.dll 0x100dc650 */
    "CREATE TABLE IF NOT EXISTS \"ct_dept_info\" (   \"dept_code\"   TEXT NOT NULL,   \"father_code\"   TEXT,   \"dept_name_cn\"   TEXT,   \"dept_name_en\"   TEXT,   \"dept_level\"   INTEGER,   \"curr_manager_number\"   TEXT,   \"manager_accounts\"   TEXT,   \"manager_names\"\tTEXT,   \"manager_names_en\"\tTEXT,   \"dept_all_code\"   TEXT,   \"order_no\"   INTEGER,   \"initial_type\"   INTEGER,   \"customer_care_flag\"   INTEGER,   \"remark\"   TEXT,   \"corp_dept_code\"   TEXT,   \"dept_type\"   INTEGER,   \"ext\"   TEXT,   \"user_sort_type\"   INTEGER,   \"last_updated_time\"   TEXT,   \"last_sync_time\"  INTEGER, \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT, \"ext4\" TEXT, \"ext5\" TEXT, PRIMARY KEY(\"dept_code\")  )",
    /* contact.dll 0x100dc8f0 */
    "CREATE TABLE IF NOT EXISTS \"ct_person_dept\" (    \"person_account\"    TEXT,    \"dept_code\"    TEXT,    \"order_in_depts\"    INTEGER,    \"main_dept\"    INTEGER,    \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT,UNIQUE(\"person_account\", \"dept_code\", \"main_dept\"))",
    /* contact.dll 0x100dc9f0 */
    "CREATE TABLE IF NOT EXISTS \"ct_role\" (    \"role_id\"    TEXT,    \"role_name\"    TEXT,    \"role_type\"    INTEGER,    \"role_father\"    TEXT,    \"last_updated_time\"    TEXT,    \"last_sync_time\"  INTEGER, \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT, \"ext4\" TEXT, \"ext5\" TEXT, PRIMARY KEY(\"role_id\")   )",
    /* contact.dll 0x100dcb18 */
    "CREATE TABLE IF NOT EXISTS \"ct_tenant\" ( \"company_code\"  TEXT, \"company_name_cn\"  TEXT, \"company_name_en\"  TEXT, \"company_type\"  TEXT, \"registered_numbers\"  INTEGER, \"email_type\"  INTEGER, \"gab_strategy\"  INTEGER, \"tenant_type\"  INTEGER, \"real_name_auth\"  INTEGER, \"dept_tree_style\"  TEXT, \"hidden_info\"  TEXT, \"org_hidden\"  INTEGER, \"last_sync_time\"  INTEGER, \"last_updated_time\"  INTEGER, \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT, \"ext4\" TEXT, \"ext5\" TEXT, PRIMARY KEY(\"company_code\"))",
    /* contact.dll 0x100dcd00 */
    "CREATE TABLE IF NOT EXISTS \"ct_tenant_define_info\" ( \"key_id\" TEXT, \"key_name_cn\" TEXT, \"key_name_en\" TEXT, \"displayable\" INTEGER, \"editable\" INTEGER, \"is_deleted\" INTEGER, \"is_basic\" INTEGER, \"key_type\" INTEGER, \"key_order\" INTEGER, \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT, PRIMARY KEY(\"key_id\"))",
    /* contact.dll 0x100dce30 */
    "CREATE TABLE IF NOT EXISTS \"ct_gal_his\" ( \"version\"\tINTEGER, \"rows\"\tINTEGER, \"sync_time\"\tINTEGER, \"time_consuming\"\tINTEGER)",
    /* contact.dll 0x100dceb0 */
    "CREATE TABLE IF NOT EXISTS \"ct_external_tenant\" ( \"company_code\" TEXT, \"suffix\" TEXT UNIQUE, \"relation\" INTEGER, \"company_name_cn\" TEXT, \"company_name_en\" TEXT, \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT, \"ext4\" TEXT, \"ext5\" TEXT, PRIMARY KEY(\"company_code\"));",
    /* contact.dll 0x100dcfb0 */
    "CREATE TABLE IF NOT EXISTS \"ct_extern_person\" ( \"person_account\" TEXT, \"company_code\" TEXT, \"company_name_cn\" TEXT, \"company_name_en\" TEXT, \"company_type\" TEXT, \"person_code\" TEXT, \"person_number\" TEXT, \"person_name_cn\" TEXT, \"person_name_en\" TEXT, \"person_pinyin_name\" TEXT, \"firstname\" TEXT, \"lastname\" TEXT, \"sex\" TEXT, \"birthday\" TEXT, \"web_site\" TEXT, \"person_assistant_number\" TEXT, \"posts_rank\" TEXT, \"person_competence\" TEXT, \"user_reg_number\" TEXT, \"person_phone_code\" TEXT, \"fax_code\" TEXT, \"imno_code\" TEXT, \"person_mobile_viop_code\" TEXT, \"person_internal_code\" TEXT, \"person_email\" TEXT, \"person_room\" TEXT, \"person_address\" TEXT, \"location_code\" TEXT, \"zip_code\" TEXT, \"photo_last_updated_time\" TEXT, \"source\" TEXT, \"person_diffierence_time\" TEXT, \"time_zone\" TEXT, \"person_signed\" TEXT, \"sip_num\" TEXT, \"vmr_id\" TEXT, \"card_id\" TEXT, \"operation_status\" INTEGER, \"is_hidden\" INTEGER, \"remark\" TEXT, \"senior_mode\" INTEGER, \"moblie0\" TEXT, \"moblie1\" TEXT, \"moblie2\" TEXT, \"moblie3\" TEXT, \"moblie4\" TEXT, \"last_updated_time\" TEXT, \"avatar_default_en\" TEXT, \"avatar_default_cn\" TEXT, \"avatar_default_en_large\" TEXT, \"avatar_default_cn_large\" TEXT, \"avatar_custom\" TEXT, \"avatar_custom_large\" TEXT, \"last_sync_time\"  INTEGER, \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT, \"ext4\" TEXT, \"ext5\" TEXT, PRIMARY KEY(\"person_account\"))",
    /* contact.dll 0x100dd4e8 */
    "CREATE TABLE IF NOT EXISTS \"ct_config\" ( \"key\"\tTEXT, \"value\"\tTEXT, PRIMARY KEY(\"key\"))",
    /* contact.dll 0x100dd540 */
    "CREATE TABLE IF NOT EXISTS \"schema_update_historay\" ( \"version\" INTEGER, \"description\" TEXT, \"sql_file\" TEXT NOT NULL, \"timestamp\" INTEGER NOT NULL, PRIMARY KEY(\"version\"))",
    /* contact.dll 0x100dd5f0 */
    "CREATE TABLE IF NOT EXISTS \"ct_person_remark\" ( \"person_account\" TEXT, \"remark\" TEXT, \"ext1\" TEXT, \"ext2\" TEXT, \"ext3\" TEXT, \"ext4\" TEXT, \"ext5\" TEXT, PRIMARY KEY(\"person_account\"))",
    /* contact.dll 0x100dd6a8 */
    "CREATE TABLE IF NOT EXISTS \"ct_account_privilage\" (  \"identity\"  TEXT NOT NULL,  \"type\"  INTEGER,  \"visiable\"  INTEGER,  \"ext1\"  TEXT,  \"ext2\"  TEXT,  \"ext3\"  TEXT,  PRIMARY KEY(\"identity\"));",
    /* contact.dll 0x100dd768 */
    "CREATE INDEX IF NOT EXISTS \"IDX_DEPT_PERSON\" ON \"ct_dept_info\" ( \"dept_code\")",
    /* contact.dll 0x100dd7c0 */
    "CREATE INDEX IF NOT EXISTS \"IDX_PERSON_DEPT\" ON \"ct_person_dept\" (\"person_account\")",
    /* contact.dll 0x100dd818 */
    "CREATE INDEX IF NOT EXISTS \"IDX_PERSON_EXT\" ON \"ct_person_ext\" (\"person_account\",\"key_id\")",
    "INSERT OR IGNORE INTO schema_update_historay(version,description,sql_file,timestamp) VALUES(1,'init','init.sql',0)",
};
#endif
