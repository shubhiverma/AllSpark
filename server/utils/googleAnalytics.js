const fetch = require('node-fetch');
const config = require('config');
const Job = require('./jobs/job');
const Task = require('./jobs/task');
const Contact = require('./jobs/contact');
const mysql = require('./mysql').MySQL;
const GoogleAPIs = require('./oauthConnections').GoogleAPIs;
const constants = require('./constants');
const OauthProvider = require('../www/oauth/connections').get;
const commonFunc = require('./commonFunctions');

class GoogleAnalytics extends Job {

	constructor(job) {

		super(job, [
			{
			  name: 'Authenticate Saved Connection',
			  timeout: 30,
			  sequence: 1,
			  fatal: 1
			},
			{
				name: 'Fetch GA',
				timeout: 30,
				sequence: 2,
				fatal: 1
			},
			{
				name: 'Process GA',
				timeout: 30,
				sequence: 3,
				inherit_data: 1,
				fatal: 1
			},
			{
				name: 'Save GA',
				timeout: 30,
				sequence: 4,
				inherit_data: 1,
				fatal: 1
			},
		]);
	}

	async fetchInfo() {

		if (this.job == parseInt(this.job)) {

			const [job] = await mysql.query(
				"select * from tb_jobs where job_id = ? and is_enabled = 1 and is_deleted = 0",
				[this.job]
			);

			this.job = job;
		}

		if (!this.job || this.tasks) {

			this.error = "job or job tasks not found";
		}

		this.contact = new Contact(this.job.job_id);

		const [account] = global.accounts.filter(x => x.account_id == this.job.account_id);

		const taskClasses = [Authenticate, FetchGA, ProcessGA, SaveGA];

		this.tasks = this.tasks.map((x, i) => {
			return new taskClasses[i]({...x, account, config: this.job.config, job_id: this.job.job_id});
		});

		this.error = 0;
	}
}

class Authenticate extends Task {

	async fetchInfo() {

		this.taskRequest = () => (async () => {

			if (!this.task.account.settings.get("load_saved_connection")) {

				return {
					status: false,
					message: "save connection missing"
				};
			}

			return {
				status: true
			};

		})();
	}
}

class FetchGA extends Task {

	constructor(task) {

		super(task);

		this.task.config = commonFunc.isJson(this.task.config) ? JSON.parse(this.task.config) : {};

	}

	async fetchInfo() {

		this.taskRequest = () => (async () => {

			let provider = new OauthProvider();

			[provider] = await provider.get({connection_id: this.task.config.connection_id});

			if (!provider || provider.type != 'Google') {

				return {
					status: false,
					data: 'Invalid provider Id or provider type'
				};
			}

			const parameters = {};

			for(const param of this.externalParams) {

				parameters[param.placeholder] = param.value;
			}

			const
				connection = new GoogleAPIs(this, provider),
				access_token = await connection.test(),
				gaMetrics = [],
				gaDimensions = [],
				startDate = parameters.start_date || new Date().toISOString().substr(0, 10),
				endDate = parameters.end_date || new Date().toISOString().substr(0, 10);

			for (const metric of (typeof this.task.config.metrics == 'string' ? [this.task.config.metrics] : this.task.config.metrics)) {

				gaMetrics.push({
					"expression": metric
				});
			}

			for (const dimension of (typeof this.task.config.dimensions == 'string' ? [this.task.config.dimensions] : this.task.config.dimensions)) {

				gaDimensions.push({
					"name": dimension
				});
			}

			const
				options = {
					method: 'POST',
					body: JSON.stringify({
						'reportRequests': [
							{
								'viewId': this.task.config.viewId,
								'dateRanges': [{'startDate': startDate, 'endDate': endDate}],
								'metrics': gaMetrics,
								"dimensions": gaDimensions,
								"orderBys": this.task.config.orderBys || []
							}
						]
					}),
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${access_token}`
					},
				};

			let response = await fetch('https://analyticsreporting.googleapis.com/v4/reports:batchGet', options);

			response = await response.json();

			this.assert(response.reports[0].data.rows, 'No data found');

			return {
				status: true,
				data: response.reports[0]
			};
		})();

	}
}

class ProcessGA extends Task {

	async fetchInfo() {

		this.taskRequest = () => (async () => {

			const processedData = [];

			let [response] = this.externalParams.filter(x => x.placeholder == 'data');

            response = response.value && commonFunc.isJson(response.value) ? JSON.parse(response.value).message.data : {data: {}};

			let query_columns = {};

			for(const dimension of response.columnHeader.dimensions) {

				query_columns[`\`${dimension}\``] = 'varchar(500) DEFAULT \'\'';
			}

			for(const metric of response.columnHeader.metricHeader.metricHeaderEntries) {

				query_columns[`\`${metric.name}\``] = 'varchar(500) DEFAULT \'\'';
			}

			for (const row of response.data.rows || []) {

				const rowObj = [];

				for (const dimension of row.dimensions) {

					rowObj.push(dimension);
				}

				for (const metric of row.metrics[0].values) {

					rowObj.push(metric);
				}

				processedData.push(rowObj);
			}

			return {
				status: true,
				data: {
					processedData,
					query_columns
				}
			}

		})();
	}

}

class SaveGA extends Task {

	async fetchInfo() {

		this.taskRequest = () => (async () => {

			let [response] = this.externalParams.filter(x => x.placeholder == 'data');

            response = response.value && commonFunc.isJson(response.value) ? JSON.parse(response.value).message.data : {};

			let
				conn = this.task.account.settings.get("load_saved_connection"),
				savedDatabase = this.task.account.settings.get("load_saved_database"),
				db = await mysql.query("show databases", [], conn);

			savedDatabase = savedDatabase || constants.saveQueryResultDb;

			[db] = db.filter(x => x === savedDatabase);

			if (!db) {

				await mysql.query(
					`CREATE DATABASE IF NOT EXISTS ${savedDatabase}`,
					[],
					conn
				);
			}

			let table_query = '';

			for(const key in response.query_columns) {

				table_query = table_query.concat(`${key} ${response.query_columns[key]},`);
			}

			const query = `
				CREATE TABLE IF NOT EXISTS ??.?? (
					id int(11) unsigned NOT NULL AUTO_INCREMENT,
					${table_query}
					\`created_at\` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
					\`updated_at\` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
					PRIMARY KEY (\`id\`),
					KEY \`created_at\` (\`created_at\`)
				) ENGINE=InnoDB DEFAULT CHARSET=latin1
			`;

			const tableName = constants.saveQueryResultTable.concat(`_job_${this.task.job_id}`);

			await mysql.query(
				query,

				[savedDatabase, tableName],
				conn,
			);

			const insertResponse = await mysql.query(
				`INSERT INTO ??.?? (${Object.keys(response.query_columns)}) VALUES ?`,
				[savedDatabase, tableName, response.processedData],
				conn
			);

			return {
				status: true,
				data: {
					message: `Data saved in the table ${constants.saveQueryResultTable}`,
					response: insertResponse
				}
			}
		})();
	}

}

module.exports = GoogleAnalytics;