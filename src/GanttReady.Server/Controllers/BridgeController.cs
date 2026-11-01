using Microsoft.AspNetCore.Mvc;
using System.Text.Json.Serialization;
using GanttReady.Server.Models;
using GanttReady.Server.Services;

namespace GanttReady.Server.Controllers;

/// <summary>
/// 投标助手桥接 API（fork 补丁 #1）：
/// 供外部脚本把结构化进度模型（PDM 语义，lag 已按 GanttReady 半开区间口径换算）一键导入为项目，
/// 并以 JSON 回读 CPM 计算结果，用于双引擎交叉验证与数据回写。
/// 注意：本控制器只做"数据搬运 + 触发排程"，不复制任何排程算法；CPM 一律走 ScheduleEngine。
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class BridgeController : ControllerBase
{
    private readonly IProjectService _projects;
    private readonly ILogger<BridgeController> _logger;

    public BridgeController(IProjectService projects, ILogger<BridgeController> logger)
    {
        _projects = projects;
        _logger = logger;
    }

    // ---------- DTO ----------

    public class BridgeImportRequest
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("code")] public string? Code { get; set; }
        [JsonPropertyName("description")] public string? Description { get; set; }
        [JsonPropertyName("start_date")] public DateTime StartDate { get; set; }
        /// <summary>true=日历天口径（周 7 天均为工作日）；false=按默认周一~五</summary>
        [JsonPropertyName("calendar_days")] public bool CalendarDays { get; set; } = true;
        [JsonPropertyName("tasks")] public List<BridgeTask> Tasks { get; set; } = new();
        [JsonPropertyName("links")] public List<BridgeLink> Links { get; set; } = new();
    }

    public class BridgeTask
    {
        [JsonPropertyName("code")] public string Code { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        /// <summary>工期（天）。里程碑传 0 并置 isMilestone=true。</summary>
        [JsonPropertyName("duration")] public int Duration { get; set; }
        /// <summary>父任务代号（须在 tasks 中且先于子项出现）；无父级留空。</summary>
        [JsonPropertyName("parent")] public string? Parent { get; set; }
        [JsonPropertyName("is_milestone")] public bool IsMilestone { get; set; }
        /// <summary>里程碑/固定节点：技能口径"第N天"（1-based）。设置后该任务按手工排程固定日期，不随 CPM 浮动。</summary>
        [JsonPropertyName("manual_day")] public int? ManualDay { get; set; }
    }

    public class BridgeLink
    {
        [JsonPropertyName("from")] public string From { get; set; } = "";
        [JsonPropertyName("to")] public string To { get; set; } = "";
        /// <summary>FS | SS | FF | SF</summary>
        [JsonPropertyName("type")] public string Type { get; set; } = "FS";
        [JsonPropertyName("lag")] public int Lag { get; set; }
        /// <summary>逻辑性质备注（工艺/组织/资源/外部）</summary>
        [JsonPropertyName("nature")] public string? Nature { get; set; }
    }

    // ---------- POST /api/bridge/import ----------

    [HttpPost("import")]
    public async Task<IActionResult> Import([FromBody] BridgeImportRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return BadRequest(new { error = "name 不能为空" });
        if (req.Tasks.Count == 0)
            return BadRequest(new { error = "tasks 不能为空" });

        var codes = req.Tasks.Select(t => t.Code).ToList();
        if (codes.Any(c => string.IsNullOrWhiteSpace(c)))
            return BadRequest(new { error = "tasks 存在空 code" });
        if (codes.GroupBy(c => c).Any(g => g.Count() > 1))
            return BadRequest(new { error = $"tasks code 重复: {string.Join(',', codes.GroupBy(c => c).Where(g => g.Count() > 1).Select(g => g.Key))}" });

        var codeSet = codes.ToHashSet();
        foreach (var link in req.Links)
        {
            if (!codeSet.Contains(link.From) || !codeSet.Contains(link.To))
                return BadRequest(new { error = $"links 引用了不存在的 code: {link.From}->{link.To}" });
            if (!Enum.TryParse<RelationType>(link.Type, ignoreCase: true, out _))
                return BadRequest(new { error = $"links 关系类型非法（仅 FS/SS/FF/SF）: {link.From}->{link.To} = {link.Type}" });
        }

        try
        {
            // 1. 建项目：日历天口径 → 周一~周日全工作日（bit0~bit6 全 1 = 127）
            var project = new Project
            {
                Code = string.IsNullOrWhiteSpace(req.Code)
                    ? $"BRIDGE-{DateTime.UtcNow:yyyyMMdd-HHmmss}"
                    : req.Code!,
                Name = req.Name!,
                Description = req.Description,
                PlanStartDate = req.StartDate,
                PlanEndDate = req.StartDate,
                WorkDayBits = req.CalendarDays ? 0b01111111 : 0b00111110
            };
            project = await _projects.CreateProjectAsync(project);

            // 2. 建任务（要求父任务先于子项出现；MVP 不重排）
            var idByCode = new Dictionary<string, int>(StringComparer.Ordinal);
            for (int i = 0; i < req.Tasks.Count; i++)
            {
                var t = req.Tasks[i];
                TaskItem? parent = null;
                if (!string.IsNullOrEmpty(t.Parent))
                {
                    if (!idByCode.TryGetValue(t.Parent!, out var parentId))
                        return BadRequest(new { error = $"任务 {t.Code} 的 parent={t.Parent} 未先出现（父任务必须排在子项之前）" });
                    parent = await _projects.GetTaskByIdAsync(parentId);
                }

                var item = new TaskItem
                {
                    ProjectId = project.Id,
                    Code = t.Code!,
                    Name = t.Name!,
                    SortOrder = i + 1,
                    PlanDuration = t.IsMilestone ? 0 : Math.Max(0, t.Duration),
                    PlanStartDate = req.StartDate,
                    PlanEndDate = req.StartDate,
                    IsMilestone = t.IsMilestone,
                    OutlineLevel = parent == null ? 1 : (parent.OutlineLevel + 1),
                    ParentTaskId = parent?.Id
                };
                if (t.ManualDay.HasValue && t.ManualDay.Value > 0)
                {
                    // 固定节点（技能口径第N天，1-based）：按手工排程落位，CPM 不改其日期
                    item.IsManualSchedule = true;
                    item.PlanStartDate = req.StartDate.AddDays(t.ManualDay.Value - 1);
                    item.PlanEndDate = item.PlanStartDate;
                }
                item = await _projects.CreateTaskAsync(item);
                idByCode[t.Code!] = item.Id;
            }

            // 3. 建关系
            foreach (var l in req.Links)
            {
                Enum.TryParse<RelationType>(l.Type, ignoreCase: true, out var relType);
                await _projects.CreateRelationAsync(new TaskRelation
                {
                    ProjectId = project.Id,
                    PredecessorTaskId = idByCode[l.From],
                    SuccessorTaskId = idByCode[l.To],
                    Type = relType,
                    Lag = l.Lag
                });
            }

            // 4. 触发 CPM 排程（ScheduleEngine 计算并回写日期）
            int duration = await _projects.CalculateScheduleAsync(project.Id);

            // 5. 组装回读结果
            var tasks = await _projects.GetTasksByProjectIdAsync(project.Id);
            var relations = await _projects.GetRelationsByProjectIdAsync(project.Id);

            return Ok(new
            {
                project_id = project.Id,
                project_code = project.Code,
                duration,                       // 半开区间口径：= 技能"第N天"完成日口径的总工期
                tasks = tasks.OrderBy(t => t.SortOrder).Select(t => new
                {
                    code = t.Code,
                    name = t.Name,
                    duration = t.PlanDuration,
                    plan_start = t.PlanStartDate.ToString("yyyy-MM-dd"),
                    plan_end = t.PlanEndDate.ToString("yyyy-MM-dd"),
                    es = t.EarlyStart,          // 0-based 偏移（GanttReady 原生口径）
                    ef = t.EarlyFinish,
                    ls = t.LateStart,
                    lf = t.LateFinish,
                    tf = t.TotalFloat,
                    ff = t.FreeFloat,
                    is_critical = t.IsCritical,
                    is_milestone = t.IsMilestone,
                    parent = t.ParentTaskId == null ? null : tasks.FirstOrDefault(x => x.Id == t.ParentTaskId)?.Code
                }),
                links = relations.Select(r => new
                {
                    from = tasks.FirstOrDefault(x => x.Id == r.PredecessorTaskId)?.Code,
                    to = tasks.FirstOrDefault(x => x.Id == r.SuccessorTaskId)?.Code,
                    type = r.Type.ToString(),
                    lag = r.Lag
                })
            });
        }
        catch (InvalidOperationException ex)
        {
            // 典型：网络图回路（ScheduleEngine 抛出）
            return BadRequest(new { error = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "bridge import failed");
            return StatusCode(500, new { error = "导入失败", detail = ex.Message });
        }
    }

    // ---------- GET /api/bridge/export/{projectId} ----------

    [HttpGet("export/{projectId}")]
    public async Task<IActionResult> Export(int projectId)
    {
        var project = await _projects.GetProjectByIdAsync(projectId);
        if (project == null)
            return NotFound(new { error = $"project {projectId} 不存在" });

        var tasks = await _projects.GetTasksByProjectIdAsync(projectId);
        var relations = await _projects.GetRelationsByProjectIdAsync(projectId);

        return Ok(new
        {
            project_id = project.Id,
            project_code = project.Code,
            name = project.Name,
            plan_start = project.PlanStartDate.ToString("yyyy-MM-dd"),
            plan_end = project.PlanEndDate.ToString("yyyy-MM-dd"),
            tasks = tasks.OrderBy(t => t.SortOrder).Select(t => new
            {
                code = t.Code,
                name = t.Name,
                duration = t.PlanDuration,
                plan_start = t.PlanStartDate.ToString("yyyy-MM-dd"),
                plan_end = t.PlanEndDate.ToString("yyyy-MM-dd"),
                es = t.EarlyStart,
                ef = t.EarlyFinish,
                ls = t.LateStart,
                lf = t.LateFinish,
                tf = t.TotalFloat,
                ff = t.FreeFloat,
                is_critical = t.IsCritical,
                is_milestone = t.IsMilestone,
                parent = t.ParentTaskId == null ? null : tasks.FirstOrDefault(x => x.Id == t.ParentTaskId)?.Code
            }),
            links = relations.Select(r => new
            {
                from = tasks.FirstOrDefault(x => x.Id == r.PredecessorTaskId)?.Code,
                to = tasks.FirstOrDefault(x => x.Id == r.SuccessorTaskId)?.Code,
                type = r.Type.ToString(),
                lag = r.Lag
            })
        });
    }

    // ---------- DELETE /api/bridge/project/{projectId}（测试清理用） ----------

    [HttpDelete("project/{projectId}")]
    public async Task<IActionResult> DeleteProject(int projectId)
    {
        var project = await _projects.GetProjectByIdAsync(projectId);
        if (project == null)
            return NotFound(new { error = $"project {projectId} 不存在" });
        await _projects.DeleteProjectAsync(projectId);
        return Ok(new { deleted = projectId });
    }
}
