const API = require("../../utils/api");
const commonFun = require('../../utils/commonFunctions');
const promisify = require('util').promisify;
//const BigQuery = require('../../www/bigQuery').BigQuery;
const constants = require("../../utils/constants");
const crypto = require('crypto');
const request = require("request");
const auth = require('../../utils/auth');
const requestPromise = promisify(request);

// prepare the raw data
class report extends API {

	async load(reportObj, filterList) {

		if (reportObj && filterList) {

			this.reportObj = reportObj;
			this.filterList = filterList;
			this.reportId = reportObj.query_id;
		}

		let reportDetails = [

			this.mysql.query(`
				SELECT
				  q.*,
				  IF(user_id IS NULL, 0, 1) AS flag,
				  c.type
				FROM
					tb_query q
				LEFT JOIN
					 tb_user_query uq ON
					 uq.query_id = q.query_id
					 AND user_id = ?
				JOIN
					tb_credentials c
					ON q.connection_name = c.id
				WHERE
					q.query_id = ?
					AND is_enabled = 1
					AND is_deleted = 0
					AND q.account_id = ?
					AND c.account_id = ?
					AND c.status = 1`,

				[this.user.user_id, this.reportId, this.account.account_id, this.account.account_id],
			),

			this.mysql.query(`select * from tb_query_filters where query_id = ?`, [this.reportId])
		];

		reportDetails = await Promise.all(reportDetails);
		this.assert(reportDetails[0].length, "Report Id: " + this.reportId + " not found");

		this.reportObj = reportDetails[0][0];
		this.filters = reportDetails[1] || [];

		this.reportObj.query = this.request.body.query || this.reportObj.query;
	}

	async authenticate() {

		const authResponse = await auth.report(this.reportObj, this.user);
		this.assert(!authResponse.error, "user not authorised to get the report");
	}

	prepareFiltersForOffset() {

		//filter fields required = offset, placeholder, default_value

		const types = [
			'string',
			'number',
			'date',
			'month',
		];

		for (const filter of this.filters) {

			if (isNaN(parseFloat(filter.offset))) {

				continue;
			}

			if (types[filter.type] == 'date') {

				filter.default_value = new Date(Date.now() + filter.offset * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
				filter.value = this.request.body[constants.filterPrefix + filter.placeholder] || filter.default_value;

				if (filter.value === new Date().toISOString().slice(0, 10)) {
					this.has_today = true;

				}
			}

			if (types[filter.type] == 'month') {

				const date = new Date();

				filter.default_value = new Date(Date.UTC(date.getFullYear(), date.getMonth() + filter.offset, 1)).toISOString().substring(0, 7);
				filter.value = this.request.body[constants.filterPrefix + filter.placeholder] || filter.default_value;

				if (filter.value === new Date().toISOString().slice(0, 7)) {

					this.has_today = true;
				}
			}
		}

		for (const filter of this.filters) {

			filter.value = this.request.body[constants.filterPrefix + filter.placeholder] || filter.default_value;
		}
	}

	async report(queryId, reportObj, filterList) {

		this.reportId = this.request.body.query_id || queryId;
		// this.reportObjStartTime = new Date();
		const forcedRun = this.request.body.cached;


		await this.load(reportObj, filterList);

		await this.authenticate();

		this.prepareFiltersForOffset();

		let preparedRequest;

		switch (this.reportObj.type.toLowerCase()) {
			case "mysql":
				preparedRequest = new MySQL(this.reportObj, this.filters, this.request.body.token);
				break;
			case "api":
				preparedRequest = new APIRequest(this.reportObj, this.filters, this.request.body.token);
				break;
			case "pgsql":
				preparedRequest = new Postgres(this.reportObj, this.filters, this.request.body.token);
				break;
			default:
				this.assert(false, "Report Type " + this.reportObj.type.toLowerCase() + " does not exist", 404);
		}

		preparedRequest = preparedRequest.finalQuery;

		const engine = new ReportEngine(preparedRequest);

		const hash = "Report#report_id:" + this.reportObj.query_id + "#hash:" + engine.hash + "#";
		const redisData = await commonFun.redisGet(hash);

		let result;

		if (!forcedRun && this.reportObj.is_redis && redisData && !this.has_today) {

			try {

				result = JSON.parse(redisData);
				result.cached = {
					status: true,
					age: Date.now() - result.cached.store_time
				};
				return result;
			}
			catch (e) {
				throw new API.Exception(500, "Invalid Redis Data! :(");
			}
		}

		try {
			result = await engine.execute();
		}
		catch (e) {
			return e;
		}

		const EOD = new Date();
		EOD.setHours(23, 59, 59, 999);

		result.cached = {store_time: Date.now()};
		await commonFun.redisStore(hash, JSON.stringify(result), Math.round(EOD.getTime() / 1000));
		result.cached = {status: false};

		return result;
	}
}


class MySQL {

	constructor(reportObj, filters = [], token = null) {

		this.reportObj = reportObj;
		this.filters = filters;
		this.token = token;
	}

	get finalQuery() {

		this.prepareQuery();

		return {
			request: [this.reportObj.query, this.filterList || [], this.reportObj.connection_name,],
			type: "mysql"
		};
	}

	prepareQuery() {

		this.reportObj.query = this.reportObj.query
			.replace(/--.*(\n|$)/g, "")
			.replace(/\s+/g, ' ');

		this.filterIndices = {};

		for (const filter of this.filters) {

			this.filterIndices[filter.placeholder] = {

				indices: (commonFun.getIndicesOf(`{{${filter.placeholder}}}`, this.reportObj.query)),
				value: filter.value,
			};

			this.reportObj.query = this.reportObj.query.replace(new RegExp(`{{${filter.placeholder}}}`, 'g'), "?");
		}

		this.filterList = this.makeQueryParameters();
	}

	makeQueryParameters() {

		const filterIndexList = [];

		for (const placeholder in this.filterIndices) {

			this.filterIndices[placeholder].indices = this.filterIndices[placeholder].indices.map(x =>

				filterIndexList.push({
					value: this.filterIndices[placeholder].value,
					index: x,
				})
			);
		}

		return (filterIndexList.sort((x, y) => x.index - y.index)).map(x => x.value) || [];
	}
}

class APIRequest {

	constructor(reportObj, filters = [], token) {

		this.reportObj = reportObj;
		this.filters = filters;
		this.token = token;
	}

	get finalQuery() {

		this.prepareQuery();

		return {
			request: [{
				har: this.har,
				gzip: true,
			}],
			type: "api",
		}
	}

	prepareQuery() {

		const parameters = [];

		for (const filter of this.filters) {

			parameters.push({
				name: filter.placeholder,
				value: filter.value
			});
		}

		try {

			this.har = JSON.parse(this.reportObj.url_options);
		}

		catch (e) {

			const err = Error("url options is not JSON");
			err.status = 400;
			return err;
		}

		this.har.queryString = [];

		this.har.headers = [
			{
				name: 'content-type',
				value: 'application/x-www-form-urlencoded'
			}
		];

		this.har.url = this.reportObj.url;

		if (this.har.method === 'GET') {

			this.har.queryString = parameters;
		}

		else {

			this.har.postData = {
				mimeType: 'application/x-www-form-urlencoded',
				params: parameters,
			};
		}

		if (!this.filters.filter(f => f.placeholder === 'token').length) {

			this.har.queryString.push({
				name: 'token',
				value: this.token,
			});
		}
	}
}

class Postgres {

	constructor(reportObj, filters = [], token) {

		this.reportObj = reportObj;
		this.filters = filters;
		this.token = token;

	}

	get finalQuery() {

		this.applyFilters();

		return {
			request: [this.reportObj.query, [], this.reportObj.connection_name,],
			type: "pgsql",
		};
	}

	applyFilters() {

		this.reportObj.query = this.reportObj.query
			.replace(/--.*(\n|$)/g, "")
			.replace(/\s+/g, ' ');

		for (const filter of this.filters) {

			this.reportObj.query = this.reportObj.query.replace(new RegExp(`{{${filter.placeholder}}}`, 'g'), `'${filter.value}'`);
		}
	}
}

class ReportEngine extends API {

	constructor(parameters) {

		super();

		ReportEngine.engines = {
			mysql: this.mysql.query,
			pgsql: this.pgsql.query,
			api: requestPromise,
		};

		this.parameters = parameters;
	}

	get hash() {

		return crypto.createHash('md5').update(JSON.stringify(this.parameters)).digest('hex');
	}

	async execute() {
		this.executionTimeStart = Date.now();

		let data;

		try {
			data = await ReportEngine.engines[this.parameters.type](...this.parameters.request);
		}

		catch (e) {

			data = e
		}

		let query;

		if (["mysql", "pgsql"].includes(this.parameters.type)) {

			query = data.instance.sql;
		}

		else if (this.parameters.type === "api") {

			query = this.parameters.request;

			try {
				data = JSON.parse(data.body);
			}
			catch (e) {
				data = e
			}
		}

		return {
			data: data,
			runtime: (Date.now() - this.executionTimeStart),
			query: query,
		};
	}
}

exports.report = report;
exports.ReportEngine = ReportEngine;