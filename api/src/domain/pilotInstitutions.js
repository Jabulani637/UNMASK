'use strict';
/**
 * The institutions Unmask opens with, as data: twenty-six of them.
 *
 * This file is a *starting point for the collection*, not a rule. It is the only
 * place in the API where an institution is named, and it exists because a brand
 * new database has nothing in it: the boot gate needs at least one active
 * institution before anybody can register, and a first deployment cannot be
 * bootstrapped by a staff screen nobody can sign in to yet.
 *
 * **A domain here is a claim about where a college's students get mail**, and each
 * one was looked up in the DNS mail exchanger records on 2026-09-28. Twenty-eight of
 * the thirty domains below answer to a real mail server; the two that do not are
 * named at the end of this comment. Mostly one domain per institution — the address
 * that institution prints for its own students — and the extra ones on the Cape Town
 * and Stellenbosch rows are the domains those live documents already carry, kept so a
 * brand new database matches the deployed one. Nothing was invented on top of that: a
 * wrong domain fails in the safe direction — nobody from that school can register, the
 * site says so plainly, and the request form catches the complaint. Widening a school
 * to a second domain is one field on one document at `/staff`, in a browser, with no
 * redeploy.
 *
 * **Writing a domain into this file does not necessarily change a running site.**
 * `ensurePilot()` upserts on `shortName` with `$setOnInsert`, so this file creates
 * rows a database has never seen and leaves rows it already has exactly as they
 * are — which is what makes the `/staff` screens the honest owner of a live
 * collection. The consequence today: the deployed UCT row holds `my.uct.ac.za`,
 * which has no mail exchanger, and the `myuct.ac.za` written here will not replace
 * it on its own. That field has to be fixed at `/staff` → Institutions → UCT.
 *
 * `city` is a scoring input, nothing else: the main-campus town. Two students from
 * different institutions in one town therefore do collect the same-city tier, and a
 * Stellenbosch student does not collect it against a Cape Town one. If a campus
 * reading is wrong, the fix is the string here or the field on the live document —
 * not a change to the engine.
 *
 * `faculties` is filled for CPUT only, because that list is the one this project
 * already had from a working system. Every other institution gets an empty list,
 * which the profile form reads as "type your school" rather than as a denial.
 *
 * Measured on 2026-09-28, no mail exchanger at all:
 *   - `my.uct.ac.za` — still on the live UCT row, and the reason UCT students hit a
 *     wall. The working address domain is `myuct.ac.za`.
 *   - `northlink.ac.za` — Northlink College, the one TVET row, cannot currently
 *     receive a verification code at all.
 */

const PILOT_INSTITUTIONS = [
  // ---------------------------------------------------------------- Western Cape
  {
    name: 'Cape Peninsula University of Technology',
    shortName: 'CPUT',
    type: 'university',
    city: 'Cape Town',
    emailDomains: ['mycput.ac.za', 'cput.ac.za'],
    faculties: [
      'Engineering',
      'Informatics & Design',
      'Business & Management Sciences',
      'Applied Sciences',
      'Education',
      'Health & Wellness Sciences',
    ],
  },
  {
    name: 'University of Cape Town',
    shortName: 'UCT',
    type: 'university',
    city: 'Cape Town',
    emailDomains: ['myuct.ac.za', 'my.uct.ac.za', 'uct.ac.za'],
    faculties: [],
  },
  {
    name: 'University of the Western Cape',
    shortName: 'UWC',
    type: 'university',
    city: 'Cape Town',
    emailDomains: ['myuwc.ac.za', 'uwc.ac.za'],
    faculties: [],
  },
  {
    name: 'Stellenbosch University',
    shortName: 'STELLENBOSCH',
    type: 'university',
    city: 'Stellenbosch',
    emailDomains: ['sun.ac.za'],
    faculties: [],
  },
  {
    name: 'Northlink College',
    shortName: 'NORTHLINK',
    type: 'tvet',
    city: 'Cape Town',
    emailDomains: ['northlink.ac.za'],
    faculties: [],
  },

  // ---------------------------------------------------------------------- Gauteng
  {
    name: 'University of Johannesburg',
    shortName: 'UJ',
    type: 'university',
    city: 'Johannesburg',
    emailDomains: ['student.uj.ac.za'],
    faculties: [],
  },
  {
    name: 'University of the Witwatersrand',
    shortName: 'WITS',
    type: 'university',
    city: 'Johannesburg',
    emailDomains: ['students.wits.ac.za'],
    faculties: [],
  },
  {
    name: 'University of Pretoria',
    shortName: 'UP',
    type: 'university',
    city: 'Pretoria',
    emailDomains: ['tuks.co.za'],
    faculties: [],
  },
  {
    name: 'University of South Africa',
    shortName: 'UNISA',
    type: 'university',
    city: 'Pretoria',
    emailDomains: ['mylife.unisa.ac.za'],
    faculties: [],
  },
  {
    name: 'Sefako Makgatho Health Sciences University',
    shortName: 'SMU',
    type: 'university',
    city: 'Pretoria',
    emailDomains: ['smu.ac.za'],
    faculties: [],
  },
  {
    name: 'Vaal University of Technology',
    shortName: 'VUT',
    type: 'university',
    city: 'Vanderbijlpark',
    emailDomains: ['edu.vut.ac.za'],
    faculties: [],
  },

  // ----------------------------------------------------------------- KwaZulu-Natal
  {
    name: 'University of KwaZulu-Natal',
    shortName: 'UKZN',
    type: 'university',
    city: 'Pietermaritzburg',
    emailDomains: ['stu.ukzn.ac.za'],
    faculties: [],
  },
  {
    name: 'Durban University of Technology',
    shortName: 'DUT',
    type: 'university',
    city: 'Durban',
    emailDomains: ['dut.ac.za'],
    faculties: [],
  },
  {
    name: 'Mangosuthu University of Technology',
    shortName: 'MUT',
    type: 'university',
    city: 'Durban',
    emailDomains: ['live.mut.ac.za'],
    faculties: [],
  },
  {
    name: 'University of Zululand',
    shortName: 'UNIZULU',
    type: 'university',
    city: 'KwaDukuza',
    emailDomains: ['stu.unizulu.ac.za'],
    faculties: [],
  },

  // ------------------------------------------------------------------ Eastern Cape
  {
    name: 'Nelson Mandela University',
    shortName: 'NMU',
    type: 'university',
    city: 'Gqeberha',
    emailDomains: ['mandela.ac.za'],
    faculties: [],
  },
  {
    name: 'University of Fort Hare',
    shortName: 'UFH',
    type: 'university',
    city: 'Alice',
    emailDomains: ['ufh.ac.za'],
    faculties: [],
  },
  {
    name: 'Rhodes University',
    shortName: 'RHODES',
    type: 'university',
    city: 'Makhanda',
    emailDomains: ['ru.ac.za'],
    faculties: [],
  },
  {
    name: 'Walter Sisulu University',
    shortName: 'WSU',
    type: 'university',
    city: 'Mthatha',
    emailDomains: ['mywsu.ac.za'],
    faculties: [],
  },

  // ------------------------------------------------------- Free State and North West
  {
    name: 'North-West University',
    shortName: 'NWU',
    type: 'university',
    city: 'Potchefstroom',
    emailDomains: ['mynwu.ac.za'],
    faculties: [],
  },
  {
    name: 'University of the Free State',
    shortName: 'UFS',
    type: 'university',
    city: 'Bloemfontein',
    emailDomains: ['ufs4life.ac.za'],
    faculties: [],
  },
  {
    name: 'Central University of Technology, Free State',
    shortName: 'CUT',
    type: 'university',
    city: 'Bloemfontein',
    emailDomains: ['cut.ac.za'],
    faculties: [],
  },

  // ------------------------------------------------------ Northern Cape, Limpopo, Mpumalanga
  {
    name: 'Sol Plaatje University',
    shortName: 'SPU',
    type: 'university',
    city: 'Kimberley',
    emailDomains: ['spu.ac.za'],
    faculties: [],
  },
  {
    name: 'University of Limpopo',
    shortName: 'UL',
    type: 'university',
    city: 'Polokwane',
    emailDomains: ['myturf.ul.ac.za'],
    faculties: [],
  },
  {
    name: 'University of Venda',
    shortName: 'UNIVEN',
    type: 'university',
    city: 'Thohoyandou',
    emailDomains: ['univen.ac.za'],
    faculties: [],
  },
  {
    name: 'University of Mpumalanga',
    shortName: 'UMP',
    type: 'university',
    city: 'Mbombela',
    emailDomains: ['ump.ac.za'],
    faculties: [],
  },
];

module.exports = { PILOT_INSTITUTIONS };
